import db from "../../db/db.js";
import { emit } from "../emit.js";
import { ulid } from "../ulid.js";
import { serializeAggregate } from "../serializers/index.js";
import { sendWebhook, AUTO_DISABLE_AFTER_FAILURES, type WebhookEnvelope } from "../../notification/webhook_delivery.js";
import { isAdminEventType } from "$lib/event-taxonomy.js";
import { endpointAcceptsEvent, resolveEventScopeSubject, type EndpointScope } from "../scope.js";
import { hasNoisePolicy, nextAttemptAt, type NoisePolicy } from "../noiseControl.js";
import type {
  EventConsumer,
  OutboxEvent,
  DeliveryTarget,
  DeliveryResult,
  DeliveryOptions,
} from "../types.js";

// Outbound webhooks as a consumer of the event bus.
//
// This is the first thing registered on the bus, and it was chosen to be first
// because it is purely additive: nothing depends on it today, so if the bus
// misbehaves the worst outcome is a webhook nobody had yet. Proving the whole
// path on something with no regression surface is the point.
//
// Unordered, deliberately. Delivery to one customer's endpoint must never wait
// on delivery to another's, and a slow or dead receiver would head-of-line-block
// everyone behind it if this were `ordered`. Receivers order for themselves
// using `seq`, which the envelope carries for exactly that reason.

const CONSUMER_NAME = "webhook";

/** An endpoint with no scope rows. Shared so the fallback allocates nothing. */
const EMPTY_SCOPE: EndpointScope = { monitorTags: [], pageSlugs: [] };

/**
 * E11 part 4. The most events one request may carry.
 *
 * A cap on the blast radius of a long quiet window: an endpoint with an hour's
 * window that accumulated ten thousand events must not try to serialise all of
 * them into one body. The remainder stays PENDING and goes in the next request,
 * so nothing is lost, it just takes two.
 */
const MAX_BATCH_SIZE = 50;

/** How far back the rate ceiling looks. */
const CEILING_WINDOW_SECONDS = 60;

/**
 * The delivery target for one endpoint, carrying when it may first go out.
 *
 * An endpoint with neither knob set returns no `not_before` at all, so the relay
 * writes exactly the row it always did and pays no extra query.
 */
async function targetFor(endpoint: {
  id: number;
  batch_window_seconds: number | null;
  max_per_minute: number | null;
}): Promise<DeliveryTarget> {
  const target: DeliveryTarget = { target_type: "endpoint", target_id: String(endpoint.id) };

  const policy: NoisePolicy = {
    batchWindowSeconds: endpoint.batch_window_seconds ?? null,
    maxPerMinute: endpoint.max_per_minute ?? null,
  };
  if (!hasNoisePolicy(policy)) return target;

  const now = nowSeconds();
  // Only asked for when a ceiling is set: the batch window needs no history.
  const stats = policy.maxPerMinute
    ? await db.getRecentWebhookAttemptStats(CONSUMER_NAME, "endpoint", String(endpoint.id), now - CEILING_WINDOW_SECONDS)
    : { count: 0, oldestAt: null };

  const due = nextAttemptAt(now, policy, stats.count, stats.oldestAt);
  if (due > now) target.not_before = due;
  return target;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Builds the envelope a receiver sees.
 *
 * `data.object` is the object's *current* state from the serializer, not a
 * snapshot taken when the event was emitted. That is a real tradeoff: a delivery
 * retried six hours later carries the object as it is now, which can differ from
 * what the event described. It is the right side of the tradeoff because the
 * common failure a receiver has to survive is missing an update, and current
 * state lets it re-converge; a stale snapshot would have it write yesterday's
 * values over today's. `diff` and `data.previous` still say what the event
 * itself changed.
 */
async function buildEnvelope(event: OutboxEvent, apiVersion: string): Promise<WebhookEnvelope> {
  const diff = parseJson(event.diff);
  const object = await serializeAggregate(event.aggregate_type, event.aggregate_id);

  return {
    id: event.event_id,
    type: event.type,
    api_version: apiVersion,
    occurred_at: event.occurred_at,
    // The outbox's own id: a total, durable publish order across the instance.
    seq: event.id,
    data: {
      // Falls back to the stored payload when there is no serializer or the
      // object is gone, which is the normal case for a `*.deleted` event.
      object: object ?? parseJson(event.payload),
      previous: (diff?.before as Record<string, unknown>) ?? null,
    },
    diff,
  };
}

/**
 * E11 part 4. Claims the other deliveries that should travel in this request.
 *
 * **Claimed with the same compare-and-set the dispatcher uses**, which is what
 * makes this safe to run in two workers at once. `beginEventDeliveryAttempt`
 * moves a row from PENDING to IN_FLIGHT and reports whether it was the one that
 * moved it, so a sibling can be picked up by exactly one batch. A worker that
 * loses the race simply gets a smaller batch, and the row it lost goes out in
 * the other request rather than twice or not at all.
 *
 * Returns nothing at all for an endpoint with no batch window, so the ordinary
 * single delivery path costs no extra query.
 *
 * A dry run claims nothing: a shadow rehearsal that moved real rows to IN_FLIGHT
 * would be sending for real in the only sense that matters to the delivery log.
 */
async function claimBatch(
  endpoint: { id: number; batch_window_seconds: number | null; api_version: string },
  options: DeliveryOptions | undefined,
  now: number,
): Promise<{ envelopes: WebhookEnvelope[]; deliveryIds: number[] }> {
  const empty = { envelopes: [] as WebhookEnvelope[], deliveryIds: [] as number[] };

  if (!endpoint.batch_window_seconds || endpoint.batch_window_seconds <= 0) return empty;
  if (options?.dryRun) return empty;
  const selfId = options?.deliveryId;
  if (selfId === undefined) return empty;

  const candidates = await db.getBatchableDeliveries(
    CONSUMER_NAME,
    "endpoint",
    String(endpoint.id),
    selfId,
    now,
    MAX_BATCH_SIZE,
  );

  const envelopes: WebhookEnvelope[] = [];
  const deliveryIds: number[] = [];

  for (const candidate of candidates) {
    // The claim. Losing it is normal, not an error.
    if (!(await db.beginEventDeliveryAttempt(candidate.id, now))) continue;

    const siblingEvent = await db.getEventByEventId(candidate.event_id);
    if (!siblingEvent) {
      // The event aged out from under its delivery. Release it as DEAD rather
      // than leaving it IN_FLIGHT for the stuck-delivery sweeper to revive into
      // the same dead end every minute.
      await db.setEventDeliveryStatus(candidate.id, "DEAD", now);
      continue;
    }

    envelopes.push(await buildEnvelope(siblingEvent, endpoint.api_version));
    deliveryIds.push(candidate.id);
  }

  return { envelopes, deliveryIds };
}

/**
 * Applies one request's outcome to every row that travelled in it.
 *
 * The leading delivery is deliberately NOT settled here: the dispatcher owns
 * that row's status, its attempt count and its place in the retry ladder, and
 * writing it from inside the consumer would race the dispatcher's own write.
 * Only the siblings, which the dispatcher does not know about, are settled here.
 *
 * A failed batch sends its siblings back to PENDING rather than into the retry
 * ladder. They were never individually attempted - one request carried all of
 * them - so charging each an attempt would spend their ladders on one endpoint
 * outage, and the next pass will batch them again anyway.
 */
async function settleBatch(
  siblingIds: number[],
  selfId: number | undefined,
  result: { ok: boolean; status?: number | null; body?: string | null; error?: string | null },
  now: number,
): Promise<void> {
  const batchId = ulid();
  const all = selfId === undefined ? siblingIds : [...siblingIds, selfId];

  for (const id of siblingIds) {
    if (result.ok) {
      await db.completeEventDeliveryAttempt(id, {
        status: "DELIVERED",
        attempts: 1,
        next_attempt_at: null,
        response_code: result.status ?? null,
        response_body: result.body ?? null,
        error: null,
        updated_at: now,
      });
    } else {
      await db.setEventDeliveryStatus(id, "PENDING", now);
    }
  }

  // Stamped on success and on failure: knowing which events were in a request
  // that failed is exactly what an operator needs to read the log afterwards.
  await db.setDeliveryBatchId(all, batchId);
}

export const webhookConsumer: EventConsumer = {
  name: CONSUMER_NAME,
  mode: "live",
  ordered: false,

  /** Every active endpoint subscribed to this event type, exactly or by wildcard. */
  async targets(event: OutboxEvent): Promise<DeliveryTarget[]> {
    // Administrative events describe the instance's own configuration - who was
    // given which permission, which API key was created. They are for the audit
    // trail, and a third-party endpoint has no business receiving them. The
    // taxonomy marks them and the subscription UI never offers them; this is the
    // check that holds even if a row is written by hand.
    if (isAdminEventType(event.type)) return [];

    const endpoints = await db.getActiveWebhookEndpointsForEvent(event.org_id, event.type);
    if (endpoints.length === 0) return [];

    // E11 part 3. An endpoint may be scoped to a set of monitors or pages, so a
    // per-team channel hears about that team's services rather than the whole
    // instance.
    //
    // Filtered HERE, in `targets`, rather than in `deliver`. A scoped-out event
    // must never become a delivery row at all: doing it in `deliver` would write
    // a row, mark it skipped, and put a permanent stream of deliberate non-events
    // through the delivery log that an operator has to learn to ignore.
    //
    // Both reads are batched. `targets` runs once per event, so resolving the
    // subject once and every scope in one query keeps the fan-out at two reads
    // regardless of how many endpoints match.
    const scopes = await db.getWebhookScopesForEndpoints(endpoints.map((e) => e.id));
    const anyScoped = [...scopes.values()].some((s) => s.monitorTags.length > 0 || s.pageSlugs.length > 0);

    // Resolved once for the event and only when something is actually scoped:
    // it costs a read, and the answer cannot differ between two endpoints
    // looking at the same event.
    const subject = anyScoped ? await resolveEventScopeSubject(event) : null;
    const accepted =
      subject === null
        ? endpoints
        : endpoints.filter((e) => endpointAcceptsEvent(scopes.get(e.id) ?? EMPTY_SCOPE, subject));

    // E11 part 4. An endpoint may ask for its deliveries to be held: a batch
    // window collapses a burst into one request, a ceiling stops a flapping
    // agent drowning a channel. Neither ever drops an event, so this only ever
    // moves `not_before` forward.
    return await Promise.all(accepted.map(async (e) => await targetFor(e)));
  },

  async deliver(event: OutboxEvent, target: DeliveryTarget, options?: DeliveryOptions): Promise<DeliveryResult> {
    const endpoint = await db.getWebhookEndpointById(Number(target.target_id));
    if (!endpoint) {
      // Deleted between the relay creating the delivery row and now. Nothing to
      // retry towards.
      return { ok: false, error: "Endpoint no longer exists", permanent: true };
    }
    if (endpoint.status !== "ACTIVE") {
      return { ok: false, error: `Endpoint is ${endpoint.status}`, permanent: true };
    }

    const now = nowSeconds();
    const envelope = await buildEnvelope(event, endpoint.api_version);

    // E11 part 4. The rest of this batch, if this endpoint batches at all.
    const batch = await claimBatch(endpoint, options, now);
    const result = await sendWebhook(endpoint, envelope, now, batch.envelopes);

    // Every row that travelled in this request gets the same outcome and the
    // same batch id. Enno's decision was one row per EVENT rather than one per
    // request, so each event stays individually traceable and the delivery
    // screen keeps working unchanged, while the id says what went together.
    if (batch.deliveryIds.length > 0) {
      await settleBatch(batch.deliveryIds, options?.deliveryId, result, now);
    }

    // Health is tracked per endpoint, not per delivery: one failed delivery is
    // noise, twenty in a row is an endpoint that has gone away.
    const failures = await db.recordWebhookEndpointOutcome(endpoint.id, result.ok, now);

    if (!result.ok && failures >= AUTO_DISABLE_AFTER_FAILURES) {
      // Conditional on it still being ACTIVE, so two workers crossing the
      // threshold together disable it once and announce it once.
      if (await db.autoDisableWebhookEndpoint(endpoint.id, now)) {
        console.error(
          `webhook: endpoint ${endpoint.id} (${endpoint.name}) auto-disabled after ${failures} consecutive failures`,
        );
        await emit({
          org_id: endpoint.org_id,
          type: "webhook_endpoint.disabled",
          aggregate_id: endpoint.id,
          actor_type: "system",
          // One announcement per disabling, not per subsequent failed delivery.
          idempotency_key: `webhook_endpoint.disabled:${endpoint.id}:${now}`,
          payload: {
            endpoint_id: endpoint.id,
            name: endpoint.name,
            consecutive_failures: failures,
            last_error: result.error,
          },
        });
      }
    }

    return {
      ok: result.ok,
      response_code: result.status,
      response_body: result.body,
      error: result.error,
      permanent: result.permanent,
      request_headers: result.request_headers,
      request_body: result.request_body,
      duration_ms: result.duration_ms,
    };
  },
};

export default webhookConsumer;
