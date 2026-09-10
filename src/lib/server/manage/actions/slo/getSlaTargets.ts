import db from "$lib/server/db/db.js";
import type { ActionDefinition } from "../../types.js";

/**
 * Every SLO target in the org, with its current evaluation attached.
 *
 * The evaluation is a separate table, so a target that has never been evaluated
 * - one created less than five minutes ago - comes back with `evaluation: null`
 * rather than with zeros. The screen says "not evaluated yet", which is true,
 * instead of "100% of budget remaining", which is a guess.
 */
export default {
  action: "getSlaTargets",
  handler: async () => {
    const targets = await db.getSlaTargets();
    const evaluations = await db.getSlaEvaluations(targets.map((t) => t.id));
    const byTarget = new Map(evaluations.map((e) => [e.sla_target_id, e]));
    return {
      targets: targets.map((target) => ({ ...target, evaluation: byTarget.get(target.id) ?? null })),
    };
  },
} satisfies ActionDefinition;
