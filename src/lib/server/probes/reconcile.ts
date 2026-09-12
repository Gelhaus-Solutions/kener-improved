import db from "../db/db.js";
import GC from "../../global-constants.js";
import { assignmentDiff, resolveAssignments, type ResolvedAssignment } from "./assignment.js";

/**
 * B1e. Keeping the stored assignments equal to what the rules and exceptions mean.
 *
 * Called after anything that can change the answer: a region's rule, a monitor's
 * exception, and a monitor being created or deleted. Cheap enough to call
 * whenever in doubt - it reads three small tables, and does nothing at all when
 * the diff is empty - and it is idempotent, so calling it twice is not a bug.
 *
 * **Only probe-eligible monitors take part.** `PROBE_ELIGIBLE_TYPES` is what
 * stands between a probe and a check that needs Kener's own database, so a
 * region set to "check everything" must mean everything a probe can actually
 * run. Resolving a GROUP monitor onto a probe would produce an assignment the
 * scheduler then refuses in silence, which is the worst of both: configured,
 * visible, and doing nothing.
 */
export async function reconcileProbeAssignments(): Promise<{
  created: number;
  updated: number;
  removed: number;
}> {
  const [rules, overrides, monitors, current] = await Promise.all([
    db.getProbeRegionRules(),
    db.getMonitorRegionOverrides(),
    db.getMonitors({ status: "ACTIVE" }),
    db.getResolvedAssignments(),
  ]);

  const monitorTags = monitors
    .filter((monitor) => (GC.PROBE_ELIGIBLE_TYPES as readonly string[]).includes(monitor.monitor_type))
    .map((monitor) => monitor.tag);

  const desired = resolveAssignments({ rules, monitorTags, overrides });
  const diff = assignmentDiff(current as ResolvedAssignment[], desired);

  if (diff.create.length === 0 && diff.update.length === 0 && diff.remove.length === 0) {
    return { created: 0, updated: 0, removed: 0 };
  }

  await db.withTransaction(async () => {
    await db.applyAssignmentDiff(diff);
  });

  return { created: diff.create.length, updated: diff.update.length, removed: diff.remove.length };
}
