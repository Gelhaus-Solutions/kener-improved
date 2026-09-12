import db from "$lib/server/db/db.js";
import { REGION_RULES, DEFAULT_MODE } from "$lib/server/probes/assignment.js";
import { reconcileProbeAssignments } from "$lib/server/probes/reconcile.js";
import { MERGED_REGION_ID } from "$lib/server/db/regions.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  region_id?: number;
  rule?: string;
  mode?: string;
}

/**
 * B1e. What a region checks by default.
 *
 * `ALL` means every probe-eligible monitor, including ones created afterwards,
 * which is the whole reason the rule exists: before this, "check everything from
 * Frankfurt" was a click per monitor and a standing obligation to remember the
 * next one.
 *
 * The reconcile runs here rather than lazily at read time so that the stored
 * assignments are true the moment the operator saves, and so that the screen
 * they are looking at is showing rows rather than a rule they have to
 * mentally evaluate.
 */
export default {
  action: "setProbeRegionRule",
  audit: { targetType: "probe_region" },
  handler: async (data: Payload) => {
    const regionId = Number(data.region_id);
    if (!Number.isFinite(regionId)) throw new ActionError(400, "region_id is required");

    const rule = String(data.rule ?? "").toUpperCase();
    if (!(REGION_RULES as readonly string[]).includes(rule)) {
      throw new ActionError(400, `rule must be one of ${REGION_RULES.join(", ")}`);
    }

    // Region 0 is the merged verdict, so an agent there replaces the local check
    // entirely. That is a real and useful configuration, but "every monitor, all
    // at once, checked somewhere else instead of here" is not something to reach
    // by picking one value in a dropdown.
    if (regionId === MERGED_REGION_ID && rule === "ALL") {
      throw new ActionError(
        400,
        "The merged verdict region cannot be set to check everything: an agent there replaces Kener's own check, so each monitor has to be named deliberately.",
      );
    }

    // Regions are a scoped table, so a region belonging to another org is simply
    // not found rather than refused.
    const regions = await db.getAssignableRegions();
    if (regionId !== MERGED_REGION_ID && !regions.some((region) => region.id === regionId)) {
      throw new ActionError(404, "That region does not exist");
    }

    await db.setProbeRegionRule({ region_id: regionId, rule, mode: String(data.mode || DEFAULT_MODE) });
    const result = await reconcileProbeAssignments();
    return { rule, ...result };
  },
} satisfies ActionDefinition<Payload>;
