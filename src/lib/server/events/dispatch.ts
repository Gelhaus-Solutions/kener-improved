import db from "../db/db.js";
import { redisConnection } from "../redisConnector.js";
import { randomBytes } from "node:crypto";
import { getConsumer } from "./consumers.js";
import { nextAttemptAt, MAX_DELIVERY_ATTEMPTS } from "./retry.js";
import type { DeliveryResult, EventDeliveryRecord } from "./types.js";

// One delivery attempt, start to finish.
//
// Everything here is written on the assumption that it may be running twice for
// the same delivery at the same time, because a duplicate BullMQ job is a normal
// outcome of the relay's crash-safety design rather than an anomaly. The
// conditional status transition in `beginDeliveryAttempt` is what makes that
// safe: exactly one of the two racers changes PENDING to IN_FLIGHT, and the
// other walks away without sending anything.

/** Response bodies are stored for debugging, not archived. */
const MAX_RESPONSE_BODY = 2000;

/**
 * Request bodies get far more room than responses, because a retry rebuilds from
 * this: a truncated request body is not merely less useful, it is unreplayable.
 */
const MAX_REQUEST_BODY = 64 * 1024;

/** Ordered-consumer lock lifetime. Long enough for a slow HTTP delivery. */
const ORDER_LOCK_TTL_MS = 60_000;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function truncate(value: string | null | undefined, max = MAX_RESPONSE_BODY): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function orderLockKey(consumer: string, aggregateType: string, aggregateId: string): string {
  return `kener:event-order:${consumer}:${aggregateType}:${aggregateId}`;
}

/** SET NX PX. Returns a release token, or null when somebody else holds it. */
async function acquireOrderLock(key: string): Promise<string | null> {
  const token = randomBytes(12).toString("hex");
  const result = await redisConnection().set(key, token, "PX", ORDER_LOCK_TTL_MS, "NX");
  return result === "OK" ? token : null;
}

/**
 * Releases the lock, but only if we still hold it.
 *
 * Checked rather than a bare DEL because a delivery that overran the TTL no
 * longer owns the lock, and deleting it would strip the lock from whoever picked
 * up the aggregate next.
 */
async function releaseOrderLock(key: string, token: string): Promise<void> {
  try {
    const redis = redisConnection();
    const current = await redis.get(key);
    if (current === token) await redis.del(key);
  } catch (error) {
    // The TTL is the backstop. A lock that fails to release blocks that one
    // aggregate for at most ORDER_LOCK_TTL_MS.
    console.error("event dispatch: could not release order lock:", error);
  }
}

/** The request side of an attempt, ready for the delivery row. */
function requestColumns(result: DeliveryResult): {
  request_headers: string | null;
  request_body: string | null;
  duration_ms: number | null;
} {
  return {
    request_headers: result.request_headers ? JSON.stringify(result.request_headers) : null,
    request_body: truncate(result.request_body, MAX_REQUEST_BODY),
    duration_ms: result.duration_ms ?? null,
  };
}

async function recordFailure(delivery: EventDeliveryRecord, result: DeliveryResult, now: number): Promise<void> {
  const attempts = delivery.attempts + 1;
  // A permanent failure skips the ladder entirely. Spending nine hours retrying
  // a 400 helps nobody and keeps a broken endpoint in the working set.
  const next = result.permanent ? null : nextAttemptAt(attempts, now);
  await db.completeEventDeliveryAttempt(delivery.id, {
    status: next === null ? "DEAD" : "FAILED",
    attempts,
    next_attempt_at: next,
    response_code: result.response_code ?? null,
    response_body: truncate(result.response_body),
    error: truncate(result.error) ?? null,
    ...requestColumns(result),
    updated_at: now,
  });

  if (next === null) {
    console.error(
      `event dispatch: delivery ${delivery.id} (${delivery.consumer} -> ${delivery.target_type}/${delivery.target_id}) ` +
        `is DEAD after ${attempts} of ${MAX_DELIVERY_ATTEMPTS} attempts: ${result.error ?? result.response_code ?? "unknown"}`,
    );
  }
}

/** Marks a delivery that can never succeed, without spending attempts on it. */
async function markDead(delivery: EventDeliveryRecord, reason: string, now: number): Promise<void> {
  await db.completeEventDeliveryAttempt(delivery.id, {
    status: "DEAD",
    attempts: delivery.attempts,
    next_attempt_at: null,
    response_code: null,
    response_body: null,
    error: reason,
    updated_at: now,
  });
  console.error(`event dispatch: delivery ${delivery.id} is DEAD: ${reason}`);
}

export type DispatchOutcome = "delivered" | "failed" | "dead" | "skipped" | "deferred" | "not-claimed";

/**
 * Runs one delivery.
 *
 * Never throws: a dispatch worker that throws would be retried by BullMQ, and
 * BullMQ retries are exactly what this design replaced. Every outcome is a
 * status on the row instead.
 */
export async function runDelivery(deliveryId: number): Promise<DispatchOutcome> {
  const now = nowSeconds();
  const delivery = await db.getEventDeliveryById(deliveryId);
  if (!delivery) return "skipped";
  if (delivery.status !== "PENDING" && delivery.status !== "FAILED") return "not-claimed";

  const consumer = getConsumer(delivery.consumer);
  if (!consumer) {
    // The consumer was removed or renamed between the relay and now. Renaming a
    // registered consumer strands its in-flight deliveries this way, which is
    // why `EventConsumer.name` is documented as permanent.
    await markDead(delivery, `no consumer registered as "${delivery.consumer}"`, now);
    return "dead";
  }

  if (consumer.mode !== "live") {
    // A consumer flipped to shadow or off after its rows were created. Record
    // the row's real fate rather than delivering against the current setting.
    await db.setEventDeliveryStatus(delivery.id, consumer.mode === "shadow" ? "SHADOW" : "SKIPPED", now);
    return "skipped";
  }

  const event = await db.getEventByEventId(delivery.event_id);
  if (!event) {
    await markDead(delivery, `event ${delivery.event_id} no longer exists`, now);
    return "dead";
  }

  let lockKey: string | null = null;
  let lockToken: string | null = null;
  if (consumer.ordered && event.aggregate_type && event.aggregate_id) {
    lockKey = orderLockKey(consumer.name, event.aggregate_type, event.aggregate_id);
    lockToken = await acquireOrderLock(lockKey);
    if (!lockToken) {
      // Another delivery for this aggregate is in progress. Leave the row
      // PENDING and let the 60s sweeper bring it back; ordered consumers trade
      // latency for order by definition.
      return "deferred";
    }

    // Mutual exclusion is not ordering. The lock stops two attempts overlapping,
    // this stops a later event overtaking an earlier one that is still owed.
    //
    // The consequence is worth stating plainly: if an earlier delivery is deep
    // in the retry ladder, everything behind it on the same aggregate waits for
    // it. That is what FIFO costs, and it is why `ordered` belongs on internal
    // consumers and never on a customer's webhook endpoint.
    if (await db.hasEarlierIncompleteDelivery(consumer.name, event.aggregate_type, event.aggregate_id, event.id)) {
      await releaseOrderLock(lockKey, lockToken);
      return "deferred";
    }
  }

  try {
    // The race is settled here. A duplicate job loses this and returns without
    // making a single outbound request.
    if (!(await db.beginEventDeliveryAttempt(delivery.id, now))) return "not-claimed";

    let result: DeliveryResult;
    try {
      result = await consumer.deliver(event, { target_type: delivery.target_type, target_id: delivery.target_id });
    } catch (error) {
      // A thrown consumer is a retryable failure, not a permanent one: the
      // common causes are a timeout and a DNS blip.
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    if (result.ok) {
      await db.completeEventDeliveryAttempt(delivery.id, {
        status: "DELIVERED",
        attempts: delivery.attempts + 1,
        next_attempt_at: null,
        response_code: result.response_code ?? null,
        response_body: truncate(result.response_body),
        error: null,
        ...requestColumns(result),
        updated_at: nowSeconds(),
      });
      return "delivered";
    }

    await recordFailure(delivery, result, nowSeconds());
    return result.permanent || delivery.attempts + 1 >= MAX_DELIVERY_ATTEMPTS ? "dead" : "failed";
  } finally {
    if (lockKey && lockToken) await releaseOrderLock(lockKey, lockToken);
  }
}
