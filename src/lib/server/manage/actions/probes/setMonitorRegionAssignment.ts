import db from "$lib/server/db/db.js";
import GC from "$lib/global-constants.js";
import { OVERRIDE_DECISIONS } from "$lib/server/probes/assignment.js";
import { reconcileProbeAssignments } from "$lib/server/probes/reconcile.js";
import { MERGED_REGION_ID } from "$lib/server/db/regions.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  monitor_tag?: string;
  region_id?: number;
  decision?: string;
}

/**
 * B1e. One monitor's exception to a region's rule.
 *
 * Three values, and the third is not the absence of the other two:
 *
 *   INCLUDE  check this monitor from this region, whatever the rule says
 *   EXCLUDE  do not, whatever the rule says
 *   DEFAULT  drop the exception and go back to following the rule
 *
 * Without `DEFAULT` there would be no way to undo an `EXCLUDE` on a region set
 * to `ALL` except by adding an `INCLUDE`, which stores the opposite exception
 * rather than removing one - and the monitor would then stay assigned after the
 * region was later set to `NONE`.
 *
 * **Eligibility is refused here, not silently ignored later.** The scheduler
 * checks `PROBE_ELIGIBLE_TYPES` before dispatching, so an `INCLUDE` for a GROUP
 * or SQL monitor would be stored, shown, and then quietly do nothing forever.
 * Those types need something only Kener has, and no amount of network access
 * lets a probe supply it.
 */
export default {
  action: "setMonitorRegionAssignment",
  audit: { targetType: "probe_region" },
  handler: async (data: Payload) => {
    const monitorTag = String(data.monitor_tag ?? "").trim();
    if (!monitorTag) throw new ActionError(400, "monitor_tag is required");

    const regionId = Number(data.region_id);
    if (!Number.isFinite(regionId)) throw new ActionError(400, "region_id is required");

    const decision = String(data.decision ?? "").toUpperCase();
    if (decision !== "DEFAULT" && !(OVERRIDE_DECISIONS as readonly string[]).includes(decision)) {
      throw new ActionError(400, `decision must be one of ${OVERRIDE_DECISIONS.join(", ")}, DEFAULT`);
    }

    // Scoped, so a tag belonging to another org simply is not found.
    const monitor = await db.getMonitorsByTag(monitorTag);
    if (!monitor) throw new ActionError(404, "That monitor does not exist");

    if (decision === "INCLUDE" && !(GC.PROBE_ELIGIBLE_TYPES as readonly string[]).includes(monitor.monitor_type)) {
      throw new ActionError(
        400,
        `A ${monitor.monitor_type} monitor cannot run on a probe: it needs something only Kener has. Remote checks are limited to ${GC.PROBE_ELIGIBLE_TYPES.join(", ")}.`,
      );
    }

    if (regionId !== MERGED_REGION_ID) {
      const regions = await db.getAssignableRegions();
      if (!regions.some((region) => region.id === regionId)) {
        throw new ActionError(404, "That region does not exist");
      }
    }

    if (decision === "DEFAULT") {
      await db.deleteMonitorRegionOverride(monitorTag, regionId);
    } else {
      await db.setMonitorRegionOverride({ monitor_tag: monitorTag, region_id: regionId, decision });
    }

    const result = await reconcileProbeAssignments();
    return { decision, ...result };
  },
} satisfies ActionDefinition<Payload>;
