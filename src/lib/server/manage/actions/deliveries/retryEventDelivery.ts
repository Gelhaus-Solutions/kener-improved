import db from "$lib/server/db/db.js";
import { currentOrgId } from "$lib/server/events/eventContext.js";
import eventDispatchQueue from "$lib/server/queues/eventDispatchQueue.js";
import { dispatchJobId } from "$lib/server/events/relay.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

/**
 * Puts a dead delivery back on the ladder by hand.
 *
 * **The existing row is reset rather than a new one inserted.** The E9 plan said
 * "insert a fresh PENDING delivery for the same event_id", which the schema
 * forbids: `UNIQUE (event_id, consumer, target_type, target_id)` is what makes a
 * re-published event collapse instead of double-sending, and a second row for
 * the same target would either violate it or require weakening the guarantee
 * that the whole crash-safety design rests on. Resetting also keeps one row per
 * target, so the log shows a delivery's history rather than a pile of near
 * duplicates.
 *
 * Only DEAD rows: anything else is either already delivered or still retrying on
 * its own, and forcing an attempt would double-send. The repository enforces
 * that with a conditional update, so two operators clicking at once produce one
 * attempt.
 */
export default {
  action: "retryEventDelivery",
  audit: { targetType: "event_delivery" },
  handler: async (data: { id: number }) => {
    const id = Number(data.id);
    const delivery = await db.getEventDeliveryById(id);
    if (!delivery || delivery.org_id !== currentOrgId()) {
      throw new ActionError(404, "Delivery not found");
    }
    if (delivery.status !== "DEAD") {
      throw new ActionError(400, `Only a DEAD delivery can be retried; this one is ${delivery.status}`);
    }

    const now = Math.floor(Date.now() / 1000);
    if (!(await db.resetEventDeliveryForRetry(id, now))) {
      throw new ActionError(409, "Delivery is no longer retryable");
    }

    // Enqueued only to make the retry feel immediate. If this fails the row is
    // PENDING and due, so the 60s sweeper picks it up regardless.
    await eventDispatchQueue
      .push(id, dispatchJobId(delivery.event_id, delivery.consumer, delivery.target_type, delivery.target_id, now))
      .catch((error) => {
        console.error(`retry: could not enqueue delivery ${id}, the sweeper will:`, error);
      });

    return { success: true };
  },
} satisfies ActionDefinition<{ id: number }>;
