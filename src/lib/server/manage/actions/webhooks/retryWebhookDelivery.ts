import db from "$lib/server/db/db.js";
import { currentOrgId } from "$lib/server/events/eventContext.js";
import eventDispatchQueue from "$lib/server/queues/eventDispatchQueue.js";
import { dispatchJobId } from "$lib/server/events/relay.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

/**
 * Puts a dead delivery back on the ladder by hand.
 *
 * Only DEAD rows: anything else is either already delivered or still being
 * retried on its own, and forcing a second attempt would double-send. The
 * repository enforces that with a conditional update, so two operators clicking
 * retry at once produce one attempt.
 *
 * The row is reset first and enqueued second. If the enqueue fails the row is
 * PENDING and due, so the 60s sweeper picks it up anyway; the enqueue is only
 * there to make the retry feel immediate.
 */
export default {
  action: "retryWebhookDelivery",
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

    await eventDispatchQueue
      .push(id, dispatchJobId(delivery.event_id, delivery.consumer, delivery.target_type, delivery.target_id, now))
      .catch((error) => {
        console.error(`webhook retry: could not enqueue delivery ${id}, the sweeper will:`, error);
      });

    return { success: true };
  },
} satisfies ActionDefinition<{ id: number }>;
