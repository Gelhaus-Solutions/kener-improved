import { InsertKeyValue } from "$lib/server/controllers/siteDataController.js";
import { MERGE_POLICIES, SOURCE_MODES, parseMergeDefaults } from "$lib/server/probes/merge.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  policy?: string;
  quorumThreshold?: number;
  degradedOnDisagreement?: boolean;
  defaultWeight?: number;
  defaultTrustRank?: number;
  defaultMode?: string;
  localWeight?: number;
  localTrustRank?: number;
  localMode?: string;
}

function requireNonNegative(raw: unknown, field: string): number {
  const n = Number(raw);
  // Zero is allowed and meaningful: a weight of 0 is "this source cannot carry a
  // vote", and a trust rank of 0 is simply the most trusted.
  if (!Number.isFinite(n) || n < 0) throw new ActionError(400, `${field} must be a number of 0 or more`);
  return Math.floor(n);
}

/**
 * B1d. The instance-wide merge defaults.
 *
 * Written through `InsertKeyValue` rather than straight to the repository, so it
 * goes through `siteDataKeys`' validator and the site data cache invalidation
 * like every other setting. The validator is the second gate, not the first:
 * everything here is rejected with a sentence an operator can act on, and the
 * validator's job is to stop anything that did not come through this form.
 *
 * **The top level of the cascade, not the only one.** A region overrides these
 * defaults for every monitor, and a monitor overrides both. See `merge.ts`.
 */
export default {
  action: "setMergePolicy",
  audit: { targetType: "site_data" },
  handler: async (data: Payload) => {
    const policy = String(data.policy ?? "");
    if (!(MERGE_POLICIES as readonly string[]).includes(policy)) {
      throw new ActionError(400, `policy must be one of ${MERGE_POLICIES.join(", ")}`);
    }

    for (const [field, value] of [
      ["defaultMode", data.defaultMode],
      ["localMode", data.localMode],
    ] as const) {
      if (!(SOURCE_MODES as readonly string[]).includes(String(value))) {
        throw new ActionError(400, `${field} must be one of ${SOURCE_MODES.join(", ")}`);
      }
    }

    const quorumThreshold = Number(data.quorumThreshold);
    if (!Number.isFinite(quorumThreshold) || quorumThreshold < 1) {
      throw new ActionError(400, "quorumThreshold must be 1 or more");
    }

    // Round-tripped through the parser so what is stored is exactly what the
    // merge will later read, rather than a shape that happens to validate and
    // then resolves to something else field by field.
    const settings = parseMergeDefaults({
      policy,
      quorumThreshold: Math.floor(quorumThreshold),
      degradedOnDisagreement: data.degradedOnDisagreement === true,
      defaultWeight: requireNonNegative(data.defaultWeight, "defaultWeight"),
      defaultTrustRank: requireNonNegative(data.defaultTrustRank, "defaultTrustRank"),
      defaultMode: data.defaultMode,
      localWeight: requireNonNegative(data.localWeight, "localWeight"),
      localTrustRank: requireNonNegative(data.localTrustRank, "localTrustRank"),
      localMode: data.localMode,
    });

    await InsertKeyValue("probeMergePolicy", JSON.stringify(settings));
    return { success: true, settings };
  },
} satisfies ActionDefinition<Payload>;
