import db from "$lib/server/db/db.js";
import {
  validateEndpointPatch,
  type EndpointFields,
  type ValidatedEndpointPatch,
} from "$lib/server/inbound/validate.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload extends EndpointFields {
  id?: number;
  name?: string;
  status?: string;
}

/**
 * H1. Edits a receiver.
 *
 * The provider is deliberately not editable. It decides how every payload is
 * read, and changing it on an endpoint that already has alert history would
 * reinterpret nothing retroactively while silently changing what the next
 * request means. Making a new endpoint is one click and leaves the old history
 * attached to the reading that produced it.
 */
export default {
  action: "updateInboundEndpoint",
  audit: { targetType: "inbound_endpoint" },
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isFinite(id)) throw new ActionError(400, "id is required");

    const endpoint = await db.getInboundEndpointById(id);
    if (!endpoint) throw new ActionError(404, "That endpoint does not exist");

    const patch: ValidatedEndpointPatch & { name?: string; status?: string } = await validateEndpointPatch(data);

    if (data.name !== undefined) {
      const name = String(data.name).trim();
      if (!name) throw new ActionError(400, "A name is required");
      patch.name = name;
    }

    if (data.status !== undefined) {
      const status = String(data.status).toUpperCase();
      if (status !== "ACTIVE" && status !== "DISABLED") {
        throw new ActionError(400, "Status must be ACTIVE or DISABLED");
      }
      patch.status = status;
    }

    if (Object.keys(patch).length === 0) return { success: true, changed: 0 };
    const changed = await db.updateInboundEndpoint(id, patch);
    return { success: true, changed };
  },
} satisfies ActionDefinition<Payload>;
