import db from "../../db/db.js";
import { emit } from "../emit.js";
import { redisConnection } from "../../redisConnector.js";
import { publishPageStatus } from "../../live/publish.js";
import { getPageStatus } from "../../incidents/pageStatus.js";
import { GetMinuteStartNowTimestampUTC } from "../../tool.js";
import type { EventConsumer, OutboxEvent, DeliveryTarget, DeliveryResult } from "../types.js";

// Page status as a consumer of the bus.
//
// Before C2b the overall status of a status page existed only as a value
// rendered during a page load. Nothing else could report it: the API had no way
// to answer "what does the page say right now", a webhook could not fire when it
// changed, and `page.status_changed` was a taxonomy entry with no producer. This
// consumer is the producer.
//
// **It derives, compares and announces. It never decides.** The derivation is
// `incidents/pageStatus.ts`, shared with the page renderer, so the value a
// customer reads and the value this publishes cannot disagree - which was the
// entire point of moving the derivation server-side.
//
// **Unordered, with the safety it needs built in instead.** The obvious choice
// is `ordered: true`, and it is wrong: the framework orders per *event
// aggregate*, and this consumer's aggregate is the incident or the monitor that
// moved, not the page. Two pages recomputing from one incident would serialise
// against each other for no reason, each deferring the other until the 60-second
// sweeper came round - a page status that updates a minute later, when the item
// asks for a second.
//
// What actually needs to be atomic is narrower than FIFO: exactly one delivery
// may observe a given transition. That is a compare-and-set, and Redis does it
// in one round trip, so the remembered value is swapped and the previous value
// returned in a single indivisible step. Two concurrent deliveries computing the
// same new status produce one announcement and one no-op, whichever order they
// arrive in - and pages never block each other.

const CONSUMER_NAME = "page_status";

/**
 * Events that can move a page's status.
 *
 * Matched by prefix rather than listed exhaustively, because the cost of the two
 * directions is asymmetric: an event type added later that this list misses
 * produces a page whose published status silently stops tracking reality, while
 * one it needlessly includes costs a recomputation that finds no change and
 * announces nothing. Cheap to over-trigger, expensive to under-trigger.
 */
const TRIGGERS = ["incident.", "maintenance.", "monitor.status_changed"];

function isTrigger(type: string): boolean {
  return TRIGGERS.some((prefix) => type === prefix || type.startsWith(prefix));
}

/** Where the last announced status for a page is remembered. */
function cacheKey(orgId: number, pageId: number): string {
  return `page_status:${orgId}:${pageId}`;
}

/**
 * How long the remembered value survives.
 *
 * Long, on purpose. This is not a performance cache - the derivation runs on
 * every delivery regardless - it is the memory of what was last announced, and
 * forgetting it causes a spurious `page.status_changed` the next time anything
 * happens. A day is long enough that a quiet page does not re-announce, and short
 * enough that a deleted page's key does not live forever.
 */
const REMEMBERED_FOR_SECONDS = 24 * 3600;

/** `swapRemembered` returns this when the stored value already matched. */
const UNCHANGED = "";
/** ...and this when there was nothing stored at all. */
const FIRST_SIGHTING = "\u0000first";

/**
 * Atomically replaces the remembered status and returns what was there before.
 *
 * One round trip, so nothing can interleave between the read and the write. The
 * three outcomes are distinguishable because the caller has to treat them
 * differently: unchanged says nothing, a first sighting records without
 * announcing, and anything else is the previous value to announce a transition
 * from.
 *
 * Written as a script rather than GET-then-SET because the gap between those two
 * is exactly where a duplicate announcement comes from, and duplicates here are
 * customer-visible: two "your status page is down" webhooks for one outage.
 */
async function swapRemembered(key: string, next: RememberedStatus): Promise<string> {
  const script = `
    local previous = redis.call('GET', KEYS[1])
    if previous == ARGV[1] then return '' end
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    if previous == false then return ARGV[3] end
    return previous
  `;
  const result = await redisConnection().eval(
    script,
    1,
    key,
    JSON.stringify(next),
    String(REMEMBERED_FOR_SECONDS),
    FIRST_SIGHTING,
  );
  return String(result ?? "");
}

interface RememberedStatus {
  status: string;
  component_impact: string;
}

export const pageStatusConsumer: EventConsumer = {
  name: CONSUMER_NAME,
  // Live from the start. There is no older path publishing page status, so there
  // is nothing to double up with and nothing to rehearse against: the shadow
  // machinery exists to compare against an incumbent, and this consumer has none.
  mode: "live",
  // See the header: ordering per event aggregate would be the wrong axis, and
  // the compare-and-set below is what makes it unnecessary.
  ordered: false,

  /**
   * One target per page in the org.
   *
   * Every page rather than only the affected ones, and the reason is that
   * "affected" is harder to answer than it looks: a global incident touches every
   * page, a monitor can appear on several, and a page whose only broken component
   * was just removed from it changes status because of an event that never named
   * it. Recomputing a handful of pages is cheap; missing one leaves a customer
   * looking at a status that stopped updating.
   */
  async targets(event: OutboxEvent): Promise<DeliveryTarget[]> {
    if (!isTrigger(event.type)) return [];
    const pages = await db.getAllPages();
    return pages.map((page) => ({ target_type: "page", target_id: String(page.id) }));
  },

  async deliver(event: OutboxEvent, target: DeliveryTarget): Promise<DeliveryResult> {
    const pageId = Number(target.target_id);
    const page = await db.getPageById(pageId);
    if (!page) {
      // Deleted between the relay writing the row and this running. Permanent:
      // it will not come back.
      return { ok: false, error: `Page ${target.target_id} no longer exists`, permanent: true };
    }

    const monitors = await db.getPageMonitorsExcludeHidden(pageId);
    const status = await getPageStatus(
      monitors.map((m) => m.monitor_tag),
      GetMinuteStartNowTimestampUTC(),
    );

    const next: RememberedStatus = { status: status.status, component_impact: status.component_impact };

    let outcome: string;
    try {
      outcome = await swapRemembered(cacheKey(event.org_id, pageId), next);
    } catch (error) {
      // Redis is unreachable. Announcing without the compare-and-set would mean
      // announcing on every event, which is worse than announcing on none, so
      // this fails and lets the retry ladder try again once Redis is back.
      return { ok: false, error: `Could not compare the remembered page status: ${String(error)}` };
    }

    if (outcome === UNCHANGED) {
      return { ok: true, response_body: `No change: ${status.status}` };
    }

    // The very first delivery for a page has nothing remembered, so everything
    // looks like a transition. Announcing that would send "your status page
    // changed to All Systems Operational" to every subscriber the first time
    // anything happened after a deploy. A first sighting is recorded, not
    // announced.
    if (outcome === FIRST_SIGHTING) {
      return { ok: true, response_body: `First sighting: ${status.status}, not announced` };
    }

    const remembered = JSON.parse(outcome) as RememberedStatus;

    await emit({
      org_id: event.org_id,
      type: "page.status_changed",
      aggregate_id: pageId,
      payload: {
        page_id: pageId,
        page_path: page.page_path,
        status: status.status,
        component_impact: status.component_impact,
        status_summary: status.statusSummary,
        previous_status: remembered.status,
        previous_component_impact: remembered.component_impact,
        components: status.components,
      },
      // One announcement per page per transition. `causation_id` is the event
      // that triggered the recomputation, so two events arriving together cannot
      // both announce the same move.
      // The compare-and-set already guarantees one announcement per transition,
      // so this only has to survive a redelivery of *this* delivery row - which
      // is why the event id belongs in it. Keying on the transition alone would
      // silently swallow a page that went down, recovered and went down again.
      idempotency_key: `page.status_changed:${pageId}:${event.event_id}`,
      causation_id: event.event_id,
    });

    // G5. The same transition, to anyone with the page open. After the `emit`
    // so the durable record is written first: the bus is the source of truth and
    // this is a courtesy on top of it.
    //
    // The compare-and-set above already guarantees exactly one delivery observes
    // a given transition, so this publishes once per transition too rather than
    // once per delivery attempt.
    await publishPageStatus(event.org_id, {
      page_id: pageId,
      page_path: page.page_path,
      status: status.status,
      component_impact: status.component_impact,
      status_summary: status.statusSummary,
    });

    return { ok: true, response_body: `${remembered.status} -> ${status.status}` };
  },
};

export default pageStatusConsumer;
