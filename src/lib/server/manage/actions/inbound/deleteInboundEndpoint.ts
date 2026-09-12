import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

/**
 * H1. Removes a receiver, and the alert history that belongs to it.
 *
 * **The incidents it opened are left alone**, which is the important half. They
 * are part of the public record of what happened to a service, and deleting a
 * webhook configuration is an administrative act that must not rewrite that. The
 * alert rows go because they are only meaningful next to the endpoint that
 * received them; the incidents stay because they are meaningful on their own.
 */
export default {
  action: "deleteInboundEndpoint",
  audit: { targetType: "inbound_endpoint" },
  handler: async (data: { id?: number }) => {
    const id = Number(data.id);
    if (!Number.isFinite(id)) throw new ActionError(400, "id is required");

    const endpoint = await db.getInboundEndpointById(id);
    if (!endpoint) throw new ActionError(404, "That endpoint does not exist");

    await db.deleteInboundEndpoint(id);
    return { success: true };
  },
} satisfies ActionDefinition<{ id?: number }>;
