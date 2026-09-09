import db from "../db/db.js";
import { createHash, randomBytes } from "node:crypto";
import { activeConsumers } from "./consumers.js";
import type { EventDeliveryInsert, OutboxEvent } from "./types.js";

// The relay: the half of the outbox pattern that turns committed rows into
// delivery attempts.
//
// It has exactly one hard requirement, and it is not "deliver each event once".
// That is unachievable: any relay that both writes to a database and enqueues to
// Redis can be killed between the two, and no amount of ordering fixes it. The
// requirement is that being killed anywhere is *harmless*, which is achieved by
// making the whole pass idempotent and then simply letting it run again:
//
//   1. claim  a batch of unpublished events, with an expiring claim
//   2. insert delivery rows          -- collapses on the UNIQUE if repeated
//   3. enqueue dispatch jobs         -- collapses on the BullMQ jobId if repeated
//   4. mark the events published     -- the only step that ends the loop
//
// A crash before step 4 leaves the claim to expire and the next pass redoes
// steps 2 and 3, both of which are no-ops the second time. A crash after step 4
// has already done the work. The cost of this design is that a delivery can be
// *attempted* twice in a pathological case, which is why the dispatcher also
// guards with a conditional status transition.

/** Events per pass. Large enough to drain a burst, small enough to stay fair. */
const CLAIM_BATCH = 200;

/**
 * How long a claim is honoured before another relay may steal it.
 *
 * The tension: too short and a slow pass has its work stolen and duplicated;
 * too long and a killed process strands its batch for that long. Sixty seconds
 * is far longer than a pass takes (it is database writes and Redis adds, no
 * network calls to anyone else) and short enough that a crash is invisible.
 */
const CLAIM_TTL_SECONDS = 60;

/** Deliveries re-enqueued per sweep. */
const SWEEP_BATCH = 500;

/**
 * A delivery IN_FLIGHT for longer than this had its worker killed.
 *
 * Generous, because the failure mode of getting it wrong is sending a customer's
 * webhook twice. A dispatch that legitimately takes five minutes does not exist;
 * one that appears to is a dead worker.
 */
const STUCK_DELIVERY_SECONDS = 5 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Unique per pass, so reading claimed rows back by token cannot over-collect. */
function claimToken(): string {
  return randomBytes(12).toString("hex");
}

/**
 * The stable BullMQ job id for a delivery.
 *
 * Derived from the delivery's identity rather than its row id so it is the same
 * string on a re-published event, which is what makes BullMQ collapse the
 * duplicate. The row id would also work, but only because the UNIQUE already
 * guarantees the row is the same one, and depending on two mechanisms agreeing
 * is worse than depending on one.
 *
 * The target is hashed rather than interpolated, and that is not cosmetic:
 * **BullMQ rejects a custom job id containing a colon**, because job keys are
 * `prefix:queue:jobId`. A target id is caller data and may contain anything,
 * including a URL. Escaping would have to be exhaustive to be safe, so the
 * target goes through a hash instead and the readable half stays readable.
 *
 * `attempt` is included so a retry is a new job id: BullMQ keeps a completed
 * job's id long enough that reusing it would make the retry a silent no-op.
 */
export function dispatchJobId(
  eventId: string,
  consumer: string,
  targetType: string,
  targetId: string,
  attempt = 0,
): string {
  // NUL separated so a target of ("a", "bc") cannot hash the same as ("ab", "c").
  const target = createHash("sha1").update(`${targetType}\u0000${targetId}`).digest("hex").slice(0, 16);
  return `${consumer}.${eventId}.${target}.${attempt}`;
}

/**
 * Builds the delivery rows one event owes, across every active consumer.
 *
 * Exported so a verification driver can ask the relay directly whether a
 * suppressed event owes anybody anything. Asserting on `event.suppress` alone
 * would only prove the flag was written; this is the function that decides what
 * the flag actually means.
 */
export async function deliveriesFor(event: OutboxEvent, now: number): Promise<EventDeliveryInsert[]> {
  // Recorded but never delivered: bulk imports and replays set this so a year of
  // backfilled incidents does not page anyone.
  if (event.suppress) return [];

  const rows: EventDeliveryInsert[] = [];
  for (const { consumer, mode } of await activeConsumers()) {
    let targets;
    try {
      targets = await consumer.targets(event);
    } catch (error) {
      // One broken consumer must not stop the others, and must not stop the
      // event being published: an event stuck unpublished blocks nothing but
      // does grow the backlog forever.
      console.error(`event relay: consumer "${consumer.name}" failed to resolve targets:`, error);
      continue;
    }

    // What the mode buys, and what it costs:
    //
    //   legacy  a terminal SKIPPED row. The target list is the evidence; nothing
    //           is ever dispatched, so this cannot send and cannot render.
    //   shadow  dispatched like a live delivery when the consumer can dry-run,
    //           so the row ends up carrying the *rendered* request. Without
    //           dry-run support there is nothing safe to dispatch, so the row
    //           goes straight to SHADOW carrying only the resolved target.
    //   live    the ordinary path.
    //
    // The shadow-with-dry-run row is deliberately created PENDING and due now.
    // It travels the real dispatch path - the same claim, the same ordering
    // guard, the same worker - and only the outbound call is suppressed, which
    // is what makes the rehearsal worth anything. A row that took a different
    // route through the system would be rehearsing the wrong thing.
    const dispatchable = mode === "live" || (mode === "shadow" && consumer.supportsDryRun === true);
    const terminalStatus = mode === "legacy" ? "SKIPPED" : "SHADOW";

    for (const target of targets) {
      rows.push({
        event_id: event.event_id,
        org_id: event.org_id,
        consumer: consumer.name,
        target_type: target.target_type,
        target_id: target.target_id,
        status: dispatchable ? "PENDING" : terminalStatus,
        attempts: 0,
        next_attempt_at: dispatchable ? now : null,
        last_attempt_at: null,
        response_code: null,
        response_body: null,
        error: null,
        created_at: now,
        updated_at: now,
      });
    }
  }
  return rows;
}

export interface RelayPassResult {
  claimed: number;
  deliveriesCreated: number;
  enqueued: number;
}

/**
 * One relay pass. Safe to run concurrently with itself and safe to interrupt.
 *
 * `enqueue` is injected rather than imported so the relay can be driven in a
 * test without Redis, and so the queue module can depend on this file instead of
 * the other way round.
 */
export async function runRelayPass(
  enqueue: (deliveryId: number, jobId: string) => Promise<void>,
): Promise<RelayPassResult> {
  const now = nowSeconds();
  const events = await db.claimUnpublishedEvents(CLAIM_BATCH, claimToken(), now, CLAIM_TTL_SECONDS);
  if (events.length === 0) return { claimed: 0, deliveriesCreated: 0, enqueued: 0 };

  const rows: EventDeliveryInsert[] = [];
  for (const event of events) {
    rows.push(...(await deliveriesFor(event, now)));
  }

  await db.insertEventDeliveries(rows);

  const eventIds = events.map((e) => e.event_id);
  // Read back rather than trusting `rows`: this returns exactly the deliveries
  // that still need work, which on a repeated pass excludes everything the first
  // pass already delivered.
  const pending = await db.getPendingDeliveriesForEvents(eventIds);

  let enqueued = 0;
  for (const delivery of pending) {
    try {
      await enqueue(
        delivery.id,
        dispatchJobId(
          delivery.event_id,
          delivery.consumer,
          delivery.target_type,
          delivery.target_id,
          delivery.attempts,
        ),
      );
      enqueued++;
    } catch (error) {
      // Redis is down. The row stays PENDING and the sweeper will enqueue it
      // when Redis returns, which is the property that makes a FLUSHALL
      // survivable. Nothing is lost by giving up here.
      console.error(`event relay: could not enqueue delivery ${delivery.id}:`, error);
    }
  }

  // Last, and only now. Everything above is idempotent precisely so that this
  // line is the single point at which an event stops being reconsidered.
  await db.markEventsPublished(eventIds, now);

  return { claimed: events.length, deliveriesCreated: rows.length, enqueued };
}

export interface SweepPassResult {
  revived: number;
  enqueued: number;
}

/**
 * Re-enqueues deliveries that are due and are not in Redis.
 *
 * This is the component that makes Redis disposable. Every delivery's real state
 * lives in the database; the queue is only an accelerator. Flush Redis and this
 * pass rebuilds the work within a minute, which is not true of any design where
 * the job *is* the record.
 *
 * It also revives deliveries stuck IN_FLIGHT, which is the one recovery the
 * dispatcher cannot do for itself: the worker that was holding them is gone.
 */
export async function runSweepPass(
  enqueue: (deliveryId: number, jobId: string) => Promise<void>,
): Promise<SweepPassResult> {
  const now = nowSeconds();
  const revived = await db.reviveStuckDeliveries(now - STUCK_DELIVERY_SECONDS, now);
  const due = await db.getDueDeliveries(now, SWEEP_BATCH);

  let enqueued = 0;
  for (const delivery of due) {
    try {
      await enqueue(
        delivery.id,
        dispatchJobId(
          delivery.event_id,
          delivery.consumer,
          delivery.target_type,
          delivery.target_id,
          delivery.attempts,
        ),
      );
      enqueued++;
    } catch (error) {
      console.error(`event relay sweep: could not enqueue delivery ${delivery.id}:`, error);
    }
  }

  return { revived, enqueued };
}
