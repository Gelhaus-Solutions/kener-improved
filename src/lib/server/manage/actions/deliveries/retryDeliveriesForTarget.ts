import db from "$lib/server/db/db.js";
import { currentOrgId } from "$lib/server/events/eventContext.js";
import eventDispatchQueue from "$lib/server/queues/eventDispatchQueue.js";
import { dispatchJobId } from "$lib/server/events/relay.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  consumer: string;
  target_type: string;
  target_id: string;
}

/** Bounded so one click cannot enqueue an unbounded backlog in a single request. */
const MAX_BULK_RETRY = 500;

/**
 * Retries every dead delivery for one target.
 *
 * The operator action after a receiver has been down: retrying a day of dead
 * letters one row at a time is not something anyone will actually do, so the
 * feature that only offers per-row retry does not really offer retry.
 *
 * Replayed oldest first, so a receiver that cares about order sees the backlog
 * in the sequence it was produced.
 */
export default {
  action: "retryDeliveriesForTarget",
  audit: { targetType: "event_delivery" },
  handler: async (data: Payload) => {
    if (!data.consumer || !data.target_type) {
      throw new ActionError(400, "consumer and target_type are required");
    }

    const orgId = currentOrgId();
    const dead = await db.getDeadDeliveriesForTarget(
      orgId,
      String(data.consumer),
      String(data.target_type),
      String(data.target_id ?? ""),
      MAX_BULK_RETRY,
    );

    const now = Math.floor(Date.now() / 1000);
    let retried = 0;
    for (const delivery of dead) {
      // The same conditional reset as the single-row action, so a row another
      // operator already retried is skipped rather than attempted twice.
      if (!(await db.resetEventDeliveryForRetry(delivery.id, now))) continue;
      retried++;
      await eventDispatchQueue
        .push(
          delivery.id,
          dispatchJobId(delivery.event_id, delivery.consumer, delivery.target_type, delivery.target_id, now),
        )
        .catch((error) => {
          console.error(`retry: could not enqueue delivery ${delivery.id}, the sweeper will:`, error);
        });
    }

    return { retried, found: dead.length, capped: dead.length === MAX_BULK_RETRY };
  },
} satisfies ActionDefinition<Payload>;
