import { record } from "../../audit/writer.js";
import { isEventType } from "$lib/event-taxonomy.js";
import type { EventType } from "$lib/event-taxonomy.js";
import type { AuditActorType } from "../../types/db.js";
import type { EventConsumer, OutboxEvent, DeliveryTarget, DeliveryResult } from "../types.js";

// The audit log as a consumer of the bus.
//
// The audit trail used to have two unrelated halves. The admin pipeline logged
// every write action it dispatched, which is most of the product but only the
// part a signed-in human reaches through the dashboard. Everything else - a
// change made through the v4 API with a bearer token, an incident opened by the
// alerting queue, a webhook endpoint the delivery consumer disabled on its own -
// changed state and left nothing behind at all. Successful API-key writes were
// completely unaudited.
//
// Putting the audit log on the bus closes that, because the bus already sees
// every state change: `emit()` is called inside the transaction that makes the
// change, from the controller, regardless of which entry point called it. One
// consumer therefore covers all three entry points, where the middleware could
// only ever cover one.
//
// **The middleware does not also write.** The pipeline hands `auditWrite` the
// ids of every event emitted under the handler and it stands down when there are
// any, so each change is logged once: by this consumer when the change reached
// the bus, by the middleware when it did not. See manage/middleware/audit.ts for
// why that is observed rather than declared.
//
// Unordered, which is a deliberate departure from the H8c plan's `ordered:
// true`. Ordering here would buy nothing that is not already bought: the row's
// timestamp is the event's `occurred_at` and its `seq` is the outbox id, so the
// log reads in event order however the writes interleave. What it would cost is
// real - an ordered consumer defers a delivery whenever an earlier one for the
// same aggregate is still in flight, and a deferred delivery waits for the 60s
// sweep, so a burst of five events on one incident could take minutes to finish
// being audited. Latency on the audit log is the one thing worth avoiding here,
// because the log is what somebody reads *during* an incident.

const CONSUMER_NAME = "audit";

/**
 * System-caused events worth a row of their own.
 *
 * Every event with a human, a key or an OIDC login behind it is audited. Events
 * the system caused itself are not, by default, because most of them are not
 * evidence of anything: `monitor.status_changed` fires on every real transition
 * across every monitor, and auditing it would bury the rows somebody is actually
 * looking for under a flood nobody reads. The audit log has a different job from
 * the monitoring history, and the monitoring history already exists.
 *
 * These are the exceptions - the automatic actions that a human would otherwise
 * have taken by hand, and that somebody will eventually need to account for:
 *
 *   the alerting queue opening and resolving incidents on its own
 *   an endpoint Kener stopped sending to without being asked
 *
 * Deliberately absent: `monitor.status_changed` (volume), and the maintenance
 * reminder (it notifies, it changes nothing). Maintenance windows opening and
 * closing on schedule *are* here: they suppress alerting, so "why did nothing
 * page at 03:00" is a question this answers.
 */
const SYSTEM_EVENT_ALLOWLIST: ReadonlySet<EventType> = new Set<EventType>([
  "monitor.alert_triggered",
  "monitor.alert_resolved",
  "webhook_endpoint.disabled",
  "maintenance.started",
  "maintenance.completed",
  "maintenance.cancelled",
  "incident.created",
  "incident.state_changed",
  "incident.resolved",
  "incident.reopened",
  "incident.comment_added",
]);

const ACTOR_TYPES: ReadonlySet<string> = new Set<AuditActorType>(["user", "api_key", "system", "oidc", "anonymous"]);

/** True when this event earns an audit row. */
export function shouldAudit(actorType: string, type: string): boolean {
  if (actorType !== "system") return true;
  return isEventType(type) && SYSTEM_EVENT_ALLOWLIST.has(type);
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toColumn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export const auditConsumer: EventConsumer = {
  name: CONSUMER_NAME,
  mode: "live",
  ordered: false,

  // Nothing is sent, so there is nothing to suppress and a rehearsal would be
  // indistinguishable from the real thing. A shadow audit consumer writes its
  // resolved target and stops there, which is the honest answer.
  supportsDryRun: false,

  /**
   * One delivery per audited event, or none.
   *
   * The empty target pair is what gives exactly one row: the UNIQUE that
   * deduplicates deliveries covers `target_type` and `target_id`, and both are
   * NOT NULL, so a consumer with nothing meaningful to aim at uses "" for both
   * rather than NULL, which would not deduplicate at all.
   */
  targets(event: OutboxEvent): DeliveryTarget[] {
    return shouldAudit(event.actor_type, event.type) ? [{ target_type: "", target_id: "" }] : [];
  },

  async deliver(event: OutboxEvent): Promise<DeliveryResult> {
    // The buffered writer, the same one the middleware uses. It returns
    // synchronously and flushes on a timer, so this consumer does not hold a
    // dispatch worker open for a database round trip it does not need to wait
    // on. Losing a buffered row on a hard kill is survivable here in a way it is
    // not for the middleware: the outbox row is still there, unpublished or
    // undelivered, and the sweeper brings it back.
    record({
      // Carried from the event. The bus has always had an org, because `emit()`
      // refuses to run without one; I3f gave the middleware's two writers the
      // same, so all three paths now agree.
      org_id: event.org_id,
      // The event's own timestamp, not now. A delivery retried six hours later
      // must land in the log where the change happened, not where the retry did.
      ts: event.occurred_at,
      request_id: event.correlation_id,
      actor_type: (ACTOR_TYPES.has(event.actor_type) ? event.actor_type : "system") as AuditActorType,
      actor_id: event.actor_id,
      actor_label: event.actor_label,
      // The event type, so `incident.created` reads as `incident.created`
      // whether the dashboard, the v4 API or the alerting queue caused it. The
      // admin action name is deliberately not used: the same change made through
      // three entry points should not appear under three different names.
      action: event.type,
      // No permission was checked to produce an event. The action name that a
      // permission attaches to is the middleware's vocabulary, and rows written
      // here are not in it.
      permission: null,
      target_type: event.aggregate_type,
      target_id: event.aggregate_id,
      // An event is only ever emitted after the change it describes succeeded;
      // a refused or failed action emits nothing and is logged by
      // `auditOutcomeOnly` instead.
      outcome: "ok",
      status_code: null,
      // Not carried on the outbox row. The event describes what changed, and the
      // pipeline's own row is where the connection details live for the actions
      // that still have one. Both are joinable by `request_id`.
      ip: null,
      user_agent: null,
      before_json: toColumn((parseJson(event.diff) as { before?: unknown } | null)?.before ?? null),
      after_json: toColumn((parseJson(event.diff) as { after?: unknown } | null)?.after ?? null),
      // `seq` is the outbox id: a total publish order across the instance, and
      // the tiebreak that keeps two events in the same second readable in the
      // right sequence. `event_id` makes an audit row traceable back to the
      // delivery that wrote it.
      meta_json: toColumn({ event_id: event.event_id, seq: event.id, payload: parseJson(event.payload) }),
    });

    return { ok: true, response_body: "Audit row buffered" };
  },
};

export default auditConsumer;
