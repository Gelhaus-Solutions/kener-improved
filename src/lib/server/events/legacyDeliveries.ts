import db from "../db/db.js";
import type { DeliveryStatus } from "./types.js";

// Delivery rows written by code that is *not* a bus consumer.
//
// A legacy sender records what it did so the delivery log covers every outbound
// channel rather than only the ones already moved onto the bus. An operator
// asking "did that notification go out" does not know which subsystem was
// responsible and should not have to.
//
// These rows are terminal on arrival. The send has already happened by the time
// this is called, so there is nothing pending and nothing due: the row is a
// record, not a work item. That distinction matters more than it looks - a row
// left PENDING would be picked up by the relay's sweeper and sent a second time,
// which is the one mistake this file exists to make impossible.

/**
 * Records one completed send from a legacy path.
 *
 * Never throws. Not being able to log a notification is not a reason to have
 * withheld it, and by the time this runs it has already gone out anyway.
 */
export async function recordLegacyDelivery(args: {
  event_id: string;
  org_id: number;
  consumer: string;
  target_type: string;
  target_id: string;
  ok: boolean;
  error?: string | null;
  request_headers?: Record<string, string> | null;
  request_body?: string | null;
  duration_ms?: number | null;
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.insertEventDeliveries([
      {
        event_id: args.event_id,
        org_id: args.org_id,
        consumer: args.consumer,
        target_type: args.target_type,
        target_id: args.target_id,
        // DEAD rather than FAILED for a failure, because there is no ladder
        // behind it: the legacy sender does not retry and nothing here will
        // either. FAILED would leave `next_attempt_at` implying an attempt that
        // is never coming.
        status: (args.ok ? "DELIVERED" : "DEAD") as DeliveryStatus,
        attempts: 1,
        next_attempt_at: null,
        last_attempt_at: now,
        response_code: null,
        response_body: null,
        error: args.error ?? null,
        request_headers: args.request_headers ? JSON.stringify(args.request_headers) : null,
        request_body: args.request_body ?? null,
        duration_ms: args.duration_ms ?? null,
        created_at: now,
        updated_at: now,
      },
    ]);
  } catch (error) {
    console.error(`delivery log: could not record the ${args.consumer} send for event ${args.event_id}:`, error);
  }
}
