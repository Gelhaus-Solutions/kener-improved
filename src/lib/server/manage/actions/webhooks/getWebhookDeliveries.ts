import db from "$lib/server/db/db.js";
import { currentOrgId } from "$lib/server/events/eventContext.js";
import type { ActionDefinition } from "../../types.js";
import type { DeliveryStatus } from "$lib/server/events/types.js";

interface Payload {
  page?: number;
  limit?: number;
  status?: DeliveryStatus;
  consumer?: string;
  event_id?: string;
  target_id?: string;
}

/**
 * The delivery log, filtered.
 *
 * Reads `event_deliveries` directly rather than a webhook-specific table,
 * because there is not one: every outbound channel shares it. E9 builds the
 * screen; this is the data behind it, and it exists here so E10's retry loop can
 * be exercised without waiting for that item.
 */
export default {
  action: "getWebhookDeliveries",
  handler: async (data: Payload) => {
    const page = Math.max(1, Number(data.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(data.limit) || 50));
    const filter = {
      org_id: currentOrgId(),
      // Defaults to webhooks; E9 widens it to every consumer.
      consumer: data.consumer ?? "webhook",
      ...(data.status ? { status: data.status } : {}),
      ...(data.event_id ? { event_id: data.event_id } : {}),
      ...(data.target_id ? { target_id: data.target_id } : {}),
    };
    const [deliveries, count] = await Promise.all([
      db.getEventDeliveriesPaginated(filter, page, limit),
      db.getEventDeliveriesCount(filter),
    ]);
    return { deliveries, total: Number(count?.count ?? 0), page, limit };
  },
} satisfies ActionDefinition<Payload>;
