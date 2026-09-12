import db from "$lib/server/db/db.js";
import { generateInboundToken, hashInboundToken, inboundTokenHint } from "$lib/server/inbound/token.js";
import { INBOUND_PROVIDERS, type InboundProvider } from "$lib/server/inbound/types.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";
import { validateEndpointPatch, type EndpointFields } from "$lib/server/inbound/validate.js";

interface Payload extends EndpointFields {
  name?: string;
  provider?: string;
}

/**
 * H1. Creates a receiver, and shows its token exactly once.
 *
 * **The token is returned here and never again**, the same contract as a probe
 * agent and an API key, and the screen is built around it: a dialog that says so
 * and a rotate button for when somebody loses one. Only the hash is stored, so
 * there is nothing to show later even if somebody asks.
 */
export default {
  action: "createInboundEndpoint",
  audit: { targetType: "inbound_endpoint" },
  handler: async (data: Payload) => {
    const name = String(data.name ?? "").trim();
    if (!name) throw new ActionError(400, "A name is required");

    const provider = String(data.provider ?? "").trim().toUpperCase();
    if (!(INBOUND_PROVIDERS as readonly string[]).includes(provider)) {
      throw new ActionError(400, `provider must be one of ${INBOUND_PROVIDERS.join(", ")}`);
    }

    const patch = await validateEndpointPatch(data);

    const token = generateInboundToken();
    // A collision at 256 bits will not happen; this exists so that if one ever
    // did it would be a sentence rather than a driver error on a unique index.
    if (await db.tokenHashExists(hashInboundToken(token))) {
      throw new ActionError(500, "Could not mint a unique token, please try again");
    }

    const id = await db.createInboundEndpoint({
      name,
      provider: provider as InboundProvider,
      token_hash: hashInboundToken(token),
      token_hint: inboundTokenHint(token),
      ...patch,
    });

    return { id, token };
  },
} satisfies ActionDefinition<Payload>;
