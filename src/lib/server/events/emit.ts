import db from "../db/db.js";
import { afterCommit } from "../db/trxContext.js";
import { ulid } from "./ulid.js";
import { currentActor, currentCorrelationId, noteEmittedEvent } from "./eventContext.js";
import { EVENT_AGGREGATE_TYPE } from "$lib/event-taxonomy.js";
import type { EventInput } from "./types.js";

// The public front door of the event bus.
//
// `emit()` writes a row and nothing else. It performs no network I/O, touches no
// Redis and sends nothing, which is what makes it safe to call from inside
// `db.withTransaction(...)` alongside the state change it describes. That
// co-location is the entire point of an outbox: the event and the fact it
// describes commit together or not at all, so there is no window in which one
// exists without the other.
//
// Delivery is somebody else's job. See relay.ts.

export interface EmitResult {
  /**
   * The event that now represents this fact. On an idempotency collision this is
   * the *stored* event's id, not the one this call generated, so it is always
   * safe to reference.
   */
  event_id: string;
  /**
   * False when an `idempotency_key` collided, meaning the event was already
   * recorded. Callers doing work that must happen exactly once can branch on it;
   * most callers can ignore it.
   */
  inserted: boolean;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** JSON, or null. Never throws: an unserialisable payload must not fail a write. */
function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch (error) {
    // A circular reference in a payload is a caller bug, but losing the event
    // over it would be worse than losing the payload.
    console.error("emit: payload is not serialisable, storing null:", error);
    return null;
  }
}

function toStringOrNull(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Records that something happened.
 *
 * Call it inside the same transaction as the state change:
 *
 *     await db.withTransaction(async () => {
 *       const incident = await db.createIncident(...);
 *       await emit({ org_id, type: "incident.created", actor_type: "user", ... });
 *     });
 *
 * Called outside a transaction it still works, and is still durable; it just
 * loses the guarantee that the event and the change share a fate.
 *
 * `org_id` is required and is never defaulted here. P4 makes it the tenant
 * boundary, and a default would turn every call site that forgot it into a
 * silent cross-tenant leak instead of a compile error.
 */
export async function emit(input: EventInput): Promise<EmitResult> {
  // The ambient actor, unless the caller knows better. See eventContext.ts for
  // why this is not a parameter threaded through every controller.
  const actor = input.actor_type ? input : currentActor();

  const { inserted, event_id } = await db.insertEvent({
    event_id: ulid(),
    org_id: input.org_id,
    type: input.type,
    // Defaulted from the taxonomy so a call site states the id and not the kind,
    // and so two events about the same thing cannot disagree about what it is.
    aggregate_type: input.aggregate_type ?? EVENT_AGGREGATE_TYPE[input.type] ?? null,
    aggregate_id: toStringOrNull(input.aggregate_id),
    actor_type: actor.actor_type ?? "system",
    actor_id: toStringOrNull(actor.actor_id),
    actor_label: actor.actor_label ?? null,
    occurred_at: input.occurred_at ?? nowSeconds(),
    payload: toJson(input.payload),
    diff: toJson(input.diff),
    correlation_id: input.correlation_id ?? currentCorrelationId(),
    causation_id: input.causation_id ?? null,
    idempotency_key: input.idempotency_key ?? null,
    suppress: input.suppress ?? false,
    schema_version: input.schema_version ?? 1,
  });

  // Wake the relay so delivery starts in milliseconds rather than on the next
  // 1s tick. Deferred to after the commit for the usual reason: a relay woken
  // while the transaction is still open finds nothing and goes back to sleep,
  // and the tick would then be the real latency anyway.
  //
  // This is an optimisation and nothing depends on it, so a Redis that is down
  // costs latency and not correctness: the relay's own timer still publishes the
  // row once Redis returns. Imported lazily so merely emitting an event does not
  // drag BullMQ into a request path that may never need it.
  if (inserted && !(input.suppress ?? false)) {
    // Tells the admin pipeline that this action reached the bus, so the audit
    // row comes from the audit consumer instead of from the middleware. Both
    // conditions matter: a suppressed event is never delivered to any consumer,
    // and an idempotency collision inserted nothing, so in either case no
    // consumer will write an audit row and the middleware must still do it.
    noteEmittedEvent(event_id);

    afterCommit(async () => {
      const { nudge } = await import("../queues/eventRelayQueue.js");
      await nudge();
    });
  }

  return { event_id, inserted };
}
