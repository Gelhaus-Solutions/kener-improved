import { emit } from "$lib/server/events/emit.js";
import { currentOrgId } from "$lib/server/events/eventContext.js";
import { redact } from "$lib/server/audit/redact.js";
import type { EventType } from "$lib/event-taxonomy.js";
import type { ActionContext } from "../types.js";

/**
 * Administrative events, emitted from the pipeline rather than from handlers.
 *
 * The rule is the same one the audit middleware enforces, for the same reason:
 * **a handler never emits.** An emit written into an action handler is one that
 * gets forgotten when the next handler is added, and a taxonomy with holes is
 * worse than no taxonomy because it looks complete. One table, here, is
 * reviewable in a way that 103 scattered call sites are not.
 *
 * Note what is deliberately *absent*: incidents and maintenances. Those emit
 * from their controllers, inside the transaction that makes the change, because
 * they are business events that must not be lost. Listing them here as well
 * would emit each one twice. Administrative events do not get that treatment on
 * purpose - they describe configuration changes for the audit trail, and losing
 * one to a crash costs a log line rather than a missed customer notification.
 */

/** Before/after over the fields that actually changed, from the audit snapshot. */
export interface ActionDiff {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

type EventResolver = (data: Record<string, unknown>, diff: ActionDiff | null) => EventType | null;

/**
 * An action either maps to one event type, or to a function when the payload
 * decides. The upsert actions are the reason the function form exists: one
 * action string covers both a create and an update, and a consumer that cannot
 * tell them apart cannot render a useful activity feed.
 */
const ACTION_EVENT_MAP: Record<string, EventType | EventResolver> = {
  // Monitors. `storeMonitorData` is an upsert, and a status flip inside it is
  // the pause/resume that operators actually care about, so it is checked first.
  storeMonitorData: (data, diff) => {
    const nextStatus = diff?.after?.status;
    if (nextStatus === "INACTIVE") return "monitor.paused";
    if (nextStatus === "ACTIVE") return "monitor.resumed";
    return data.id ? "monitor.updated" : "monitor.created";
  },
  cloneMonitor: "monitor.created",
  deleteMonitor: "monitor.deleted",

  // Triggers (the legacy notification channels).
  createUpdateTrigger: (data) => (data.id ? "trigger.updated" : "trigger.created"),
  deleteTrigger: "trigger.deleted",

  // Users.
  createNewUser: "user.created",
  updateUser: "user.updated",
  manualUpdate: "user.updated",
  updatePassword: "user.updated",

  // API keys.
  createNewApiKey: "apikey.created",
  updateApiKeyStatus: "apikey.updated",
  deleteApiKey: "apikey.deleted",

  // Instance configuration.
  storeSiteData: "site_settings.updated",
  updateSubscriptionsConfig: "site_settings.updated",

  // Access control. Only the permission change: creating or renaming a role
  // grants nobody anything, and the taxonomy has one type here on purpose.
  updateRolePermissions: "role.permissions_changed",

  // Subscribers.
  adminAddSubscriber: "subscriber.created",
  adminUpdateSubscriptionStatus: "subscriber.updated",
  updateUserSubscriptionStatus: "subscriber.updated",
  adminDeleteSubscriber: "subscriber.deleted",
  deleteUserSubscription: "subscriber.deleted",
};

/** Best-effort id of the thing acted on, matching the audit middleware's guess. */
function targetId(data: Record<string, unknown>): string | null {
  for (const key of ["id", "tag", "monitor_tag", "page_id", "email", "key", "role_id", "user_id"]) {
    const v = data[key];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return null;
}

/**
 * Emits the administrative event for a successful action, if it has one.
 *
 * Never throws. This runs after the handler has already succeeded and the
 * response is about to go out; failing the request now would report a completed
 * change as an error, which is worse than a missing event.
 */
export async function emitActionEvent(
  action: string,
  data: Record<string, unknown>,
  ctx: ActionContext,
  diff: ActionDiff | null,
): Promise<void> {
  const type = resolveActionEventType(action, data, diff);
  if (!type) return;

  try {
    await emit({
      org_id: currentOrgId(),
      type,
      aggregate_id: targetId(data),
      actor_type: "user",
      actor_id: ctx.user.id,
      actor_label: ctx.user.email ?? String(ctx.user.id),
      correlation_id: ctx.requestId,
      // Redacted with the same function the audit log uses, which is
      // deliberately over-eager: an event payload is delivered to third-party
      // webhook endpoints, so anything that looks like a secret must not be in it.
      payload: redact(data),
      diff: diff ?? undefined,
    });
  } catch (error) {
    console.error(`events: failed to emit ${type} for ${action}:`, error);
  }
}

/**
 * The event an action produces, or null when it produces none.
 *
 * Split out from `emitActionEvent` so the mapping can be tested without a
 * database: the branching in the upsert entries is where the mistakes live, and
 * a test that has to stand up Postgres to check "does an edit report an update"
 * is a test nobody runs.
 */
export function resolveActionEventType(
  action: string,
  data: Record<string, unknown>,
  diff: ActionDiff | null,
): EventType | null {
  const mapped = ACTION_EVENT_MAP[action];
  if (!mapped) return null;
  return typeof mapped === "function" ? mapped(data, diff) : mapped;
}

/** The actions that produce an administrative event, for tests and review. */
export function mappedActionEvents(): string[] {
  return Object.keys(ACTION_EVENT_MAP);
}
