import db from "$lib/server/db/db.js";
import { MERGED_REGION_ID } from "$lib/server/db/regions.js";
import { MERGE_POLICIES, SOURCE_MODES } from "$lib/server/probes/merge.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface SourcePatch {
  region_id?: number;
  weight?: number | null;
  trust_rank?: number | null;
  mode?: string | null;
}

interface Payload {
  monitor_tag?: string;
  /** Null on any of these clears the override, so the monitor inherits again. */
  policy?: string | null;
  quorum_threshold?: number | null;
  degraded_on_disagreement?: boolean | null;
  sources?: SourcePatch[];
}

function optionalNonNegative(raw: unknown, field: string): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new ActionError(400, `${field} must be a number of 0 or more, or empty`);
  return Math.floor(n);
}

/**
 * B1d. One monitor's overrides: the bottom level of the cascade, and the one
 * that answers "for this one provider, trust the Frankfurt probe over the local
 * check".
 *
 * Both levels are written here in one call, because they are one decision from
 * the operator's side: choosing TRUST_ORDER for a monitor is meaningless without
 * also saying what the order is, and two actions would let the screen save half
 * of that and leave the monitor on a policy whose inputs were never set.
 *
 * **An override row exists only while it overrides something.** Clearing every
 * field deletes the row rather than storing an all-null one, so "does this
 * monitor override anything" is answerable by the row's existence and the two
 * tables stay empty on an install that configures nothing.
 */
export default {
  action: "setMonitorMergePolicy",
  audit: { targetType: "monitor" },
  handler: async (data: Payload) => {
    const monitorTag = String(data.monitor_tag ?? "").trim();
    if (!monitorTag) throw new ActionError(400, "monitor_tag is required");

    // Scoped, so a tag belonging to another org simply is not found.
    const monitor = await db.getMonitorsByTag(monitorTag);
    if (!monitor) throw new ActionError(404, "That monitor does not exist");

    if (data.policy !== undefined && data.policy !== null && data.policy !== "") {
      if (!(MERGE_POLICIES as readonly string[]).includes(String(data.policy))) {
        throw new ActionError(400, `policy must be one of ${MERGE_POLICIES.join(", ")}`);
      }
    }

    const quorum = optionalNonNegative(data.quorum_threshold, "quorum_threshold");
    if (typeof quorum === "number" && quorum < 1) {
      throw new ActionError(400, "quorum_threshold must be 1 or more, or empty to inherit");
    }

    const policy = data.policy === "" ? null : (data.policy ?? null);
    const degraded = data.degraded_on_disagreement ?? null;

    if (policy === null && quorum == null && degraded === null) {
      // Nothing left to override at this level.
      await db.deleteMonitorMergePolicy(monitorTag);
    } else {
      await db.setMonitorMergePolicy(monitorTag, {
        policy,
        quorum_threshold: quorum ?? null,
        degraded_on_disagreement: degraded,
      });
    }

    for (const source of data.sources ?? []) {
      const regionId = Number(source.region_id);
      if (!Number.isFinite(regionId)) throw new ActionError(400, "each source needs a region_id");
      if (regionId === MERGED_REGION_ID) {
        throw new ActionError(400, "The merged verdict is computed and cannot be given a weight");
      }

      if (source.mode !== undefined && source.mode !== null && source.mode !== "") {
        if (!(SOURCE_MODES as readonly string[]).includes(String(source.mode))) {
          throw new ActionError(400, `mode must be one of ${SOURCE_MODES.join(", ")}`);
        }
      }

      const weight = optionalNonNegative(source.weight, "weight");
      const trustRank = optionalNonNegative(source.trust_rank, "trust_rank");
      const mode = source.mode === "" ? null : (source.mode ?? null);

      if (weight == null && trustRank == null && mode === null) {
        await db.deleteMonitorSourcePolicy(monitorTag, regionId);
        continue;
      }
      await db.setMonitorSourcePolicy(monitorTag, regionId, {
        weight: weight ?? null,
        trust_rank: trustRank ?? null,
        mode,
      });
    }

    return { success: true };
  },
} satisfies ActionDefinition<Payload>;
