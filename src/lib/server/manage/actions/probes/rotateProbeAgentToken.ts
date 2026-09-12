import db from "$lib/server/db/db.js";
import { generateProbeToken, hashProbeToken, tokenHintOf } from "$lib/server/probes/auth.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  id?: number;
}

/**
 * B1c. Issues a new token for an existing agent, invalidating the old one.
 *
 * **There is no grace period, unlike an API key rotation.** A key is held by
 * however many deployments have copied it, so cutting it off instantly breaks
 * callers nobody has a list of; a probe token is held by exactly one daemon,
 * which is restarted with the new value. Keeping the old one alive would only
 * mean that a token an operator believes they have revoked still works.
 *
 * The agent is **not** disconnected here. Its current socket authenticated when
 * it connected and stays valid until it drops, which is deliberate: rotating a
 * token should not blank a region's monitoring for the seconds it takes an
 * operator to paste the new value in. The next reconnect is what enforces it.
 */
export default {
  action: "rotateProbeAgentToken",
  audit: { targetType: "probe_agent" },
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isFinite(id)) throw new ActionError(400, "id is required");

    const agent = await db.getProbeAgentById(id);
    if (!agent) throw new ActionError(404, "That probe agent does not exist");

    const token = generateProbeToken();
    await db.updateProbeAgent(id, {
      token_hash: hashProbeToken(token),
      token_hint: tokenHintOf(token),
    });

    return { id, token };
  },
} satisfies ActionDefinition<Payload>;
