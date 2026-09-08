import db from "$lib/server/db/db.js";
import { currentOrgId } from "$lib/server/events/eventContext.js";
import type { ActionDefinition } from "../../types.js";
import type { DeliveryStatus, EventDeliveryRecord } from "$lib/server/events/types.js";

interface Payload {
  page?: number;
  limit?: number;
  status?: DeliveryStatus;
  consumer?: string;
  event_id?: string;
  target_id?: string;
  start?: number;
  end?: number;
}

/**
 * The delivery log: every outbound attempt, whatever sent it.
 *
 * One query over `event_deliveries` covers webhooks, subscriber email and
 * anything added later, because they all write to the same table. That is the
 * point of the shared table and the reason this action is not per-channel:
 * an operator asking "did the notification go out" does not know or care which
 * subsystem was responsible.
 *
 * Each row is joined to its event so the log can show *what* was being
 * delivered, not just that something was.
 */
export default {
  action: "getEventDeliveries",
  handler: async (data: Payload) => {
    const page = Math.max(1, Number(data.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(data.limit) || 50));
    const filter = {
      org_id: currentOrgId(),
      ...(data.consumer ? { consumer: data.consumer } : {}),
      ...(data.status ? { status: data.status } : {}),
      ...(data.event_id ? { event_id: data.event_id } : {}),
      ...(data.target_id ? { target_id: data.target_id } : {}),
      ...(data.start ? { start: Number(data.start) } : {}),
      ...(data.end ? { end: Number(data.end) } : {}),
    };

    const [deliveries, count, consumers]: [EventDeliveryRecord[], { count: string | number } | undefined, string[]] =
      await Promise.all([
        db.getEventDeliveriesPaginated(filter, page, limit),
        db.getEventDeliveriesCount(filter),
        db.getDeliveryConsumers(currentOrgId()),
      ]);

    // One lookup for the page's events rather than one per row: a 50-row page
    // typically covers far fewer events, since one event fans out to many
    // targets.
    const events = await Promise.all(
      [...new Set(deliveries.map((d) => d.event_id))].map((id) => db.getEventByEventId(id)),
    );
    const byId = new Map(events.filter(Boolean).map((e) => [e!.event_id, e!]));

    return {
      deliveries: deliveries.map((d) => ({
        ...d,
        event_type: byId.get(d.event_id)?.type ?? null,
        occurred_at: byId.get(d.event_id)?.occurred_at ?? null,
        aggregate_type: byId.get(d.event_id)?.aggregate_type ?? null,
        aggregate_id: byId.get(d.event_id)?.aggregate_id ?? null,
      })),
      total: Number(count?.count ?? 0),
      consumers,
      page,
      limit,
    };
  },
} satisfies ActionDefinition<Payload>;
