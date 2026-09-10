import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  id?: number;
}

/**
 * Deletes an SLO target and the evaluation cached for it.
 *
 * The evaluation goes too, in the repository. It is derived data keyed by the
 * target's id, and leaving it would mean the next target to be assigned that id
 * inherited somebody else's error budget.
 */
export default {
  action: "deleteSlaTarget",
  audit: { targetType: "sla_target" },
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isFinite(id) || id <= 0) throw new ActionError(400, "An SLO target id is required");
    if (!(await db.getSlaTargetById(id))) throw new ActionError(404, "That SLO target does not exist");
    await db.deleteSlaTarget(id);
    return { success: true };
  },
} satisfies ActionDefinition<Payload>;
