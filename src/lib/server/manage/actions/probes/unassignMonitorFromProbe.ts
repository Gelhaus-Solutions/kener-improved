import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  id?: number;
}

/**
 * B1c. Takes a monitor back off a probe.
 *
 * Nothing else is needed to make it take effect: `planProbeExecution` reads the
 * assignment table on every check, so from the next tick the monitor is checked
 * locally again. An assignment already in flight finishes and its result is
 * stored, which is correct - the check really was made.
 */
export default {
  action: "unassignMonitorFromProbe",
  audit: { targetType: "probe_agent" },
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isFinite(id)) throw new ActionError(400, "id is required");

    const deleted = await db.deleteProbeAssignment(id);
    if (deleted === 0) throw new ActionError(404, "That assignment does not exist");
    return { deleted: true };
  },
} satisfies ActionDefinition<Payload>;
