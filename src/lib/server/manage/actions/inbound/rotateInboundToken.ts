import db from "$lib/server/db/db.js";
import { generateInboundToken, hashInboundToken, inboundTokenHint } from "$lib/server/inbound/token.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

/**
 * H1. Issues a new token, and invalidates the old one immediately.
 *
 * **No grace period, unlike an outbound webhook's signing secret.** That one
 * overlaps two secrets for a while because the *receiver* has to be updated and
 * Kener is the one signing; here Kener is the receiver, and the sender's
 * configuration is changed by the same person doing the rotating. An overlap
 * would only mean a leaked token kept working, which is the thing rotation
 * exists to stop.
 */
export default {
  action: "rotateInboundToken",
  audit: { targetType: "inbound_endpoint" },
  handler: async (data: { id?: number }) => {
    const id = Number(data.id);
    if (!Number.isFinite(id)) throw new ActionError(400, "id is required");

    const endpoint = await db.getInboundEndpointById(id);
    if (!endpoint) throw new ActionError(404, "That endpoint does not exist");

    const token = generateInboundToken();
    await db.updateInboundEndpoint(id, {
      token_hash: hashInboundToken(token),
      token_hint: inboundTokenHint(token),
    });

    return { token };
  },
} satisfies ActionDefinition<{ id?: number }>;
