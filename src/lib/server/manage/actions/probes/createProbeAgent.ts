import db from "$lib/server/db/db.js";
import { generateProbeToken, hashProbeToken, tokenHintOf } from "$lib/server/probes/auth.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  name?: string;
  region_id?: number;
  /**
   * A region to create and put this agent in, instead of picking an existing one.
   *
   * Kener seeds exactly one region, the merged verdict, and has no other screen
   * that writes to the catalogue. Without this the probes screen would allow
   * precisely one agent ever and then disable its own create button, which is a
   * dead end an operator has no way out of.
   */
  new_region?: { code?: string; name?: string };
}

/**
 * B1c. Creates a probe agent and returns its token exactly once.
 *
 * **The token is returned here and never again.** Only its HMAC is stored, plus
 * the last four characters so the list can tell two agents' tokens apart. That
 * is the same shape as an API key and for the same reason: a credential a server
 * can read back is a credential a database backup hands to whoever has it. The
 * screen is built around this - it shows the token in a dialog that says it will
 * not be shown again, and rotation is how a lost one is replaced.
 *
 * **One agent per region, refused here rather than at connect time.** B1c's
 * registry serves one agent per region, so a second one would authenticate and
 * then be closed with REGION_TAKEN - a probe that looks correctly configured and
 * silently never works. Refusing the form is the same rule where somebody can
 * still read the reason.
 */
export default {
  action: "createProbeAgent",
  audit: { targetType: "probe_agent" },
  handler: async (data: Payload) => {
    const name = String(data.name ?? "").trim();
    if (!name) throw new ActionError(400, "A name is required");

    const regionId = data.new_region ? await createRegionFor(data.new_region) : Number(data.region_id);
    if (!Number.isInteger(regionId) || regionId < 0) {
      throw new ActionError(400, "A region is required");
    }

    if (await db.regionHasAgent(regionId)) {
      throw new ActionError(
        409,
        "That region already has an agent. One agent per region is a limit of this phase, so retire the existing one first.",
      );
    }

    const token = generateProbeToken();
    const id = await db.createProbeAgent({
      name,
      region_id: regionId,
      token_hash: hashProbeToken(token),
      token_hint: tokenHintOf(token),
    });

    return { id, token };
  },
} satisfies ActionDefinition<Payload>;

/**
 * Creates the region an agent is being made for, and returns its id.
 *
 * The code is normalised rather than merely trimmed, because it is an
 * identifier: `regions.code` carries a unique index across the whole table, and
 * "eu-west" and "EU West " arriving as two rows would be two regions nobody
 * meant to have. Uniqueness is checked explicitly so the operator is told which
 * code is taken instead of seeing a driver error.
 */
async function createRegionFor(input: { code?: string; name?: string }): Promise<number> {
  const name = String(input.name ?? "").trim();
  if (!name) throw new ActionError(400, "A region name is required");

  const code = String(input.code ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!code) throw new ActionError(400, "A region code is required, using letters, numbers and hyphens");

  if (await db.regionCodeExists(code)) {
    throw new ActionError(409, `The region code "${code}" is already in use`);
  }

  return await db.createRegion({ code, name });
}
