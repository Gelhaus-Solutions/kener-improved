import db from "$lib/server/db/db.js";
import { generateProbeToken, hashProbeToken, tokenHintOf } from "$lib/server/probes/auth.js";
import { normalizeRegionCode } from "$lib/server/db/regions.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  name?: string;
  region_id?: number;
  /** B1g. This agent's say among the others in its region. Defaults to 1. */
  weight?: number;
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
 * **A region may have any number of agents.** They answer for one vantage
 * point, not as independent voters: all of them are dispatched, and their
 * answers are reduced to the single verdict that region reports before anything
 * else sees them. So a second agent in a region is redundancy, and adding it
 * changes how reliably that region answers rather than how much say it has.
 *
 * B1g. Siblings need not count equally: `weight` settles them among themselves
 * and stops at the region boundary, so weighting one agent up still cannot buy
 * its region more influence over the others.
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

    const weight = parseWeight(data.weight);

    const token = generateProbeToken();
    const id = await db.createProbeAgent({
      name,
      region_id: regionId,
      weight,
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

  const code = normalizeRegionCode(input.code);
  if (!code) throw new ActionError(400, "A region code is required, using letters, numbers and hyphens");

  if (await db.regionCodeExists(code)) {
    throw new ActionError(409, `The region code "${code}" is already in use`);
  }

  return await db.createRegion({ code, name });
}

/**
 * B1g. Validates an agent weight, defaulting to 1 when none was given.
 *
 * Zero is allowed and means "recorded, but carries no vote among its siblings".
 * There is no upper bound, matching `probe_region_rules.default_weight`: a large
 * weight is a deliberate statement that this agent decides, and capping it would
 * silently mean something other than what the operator typed.
 */
export function parseWeight(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const weight = Number(value);
  if (!Number.isInteger(weight) || weight < 0) {
    throw new ActionError(400, "Weight must be a whole number of 0 or more");
  }
  return weight;
}
