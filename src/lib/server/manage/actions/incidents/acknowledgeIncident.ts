import { AcknowledgeIncident, GetIncidentByIDDashboard } from "$lib/server/controllers/controller.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface Payload {
  id?: number | string;
}

/**
 * C2c: a human takes ownership of an open incident.
 *
 * **The acknowledger is the session, never the payload**, and that is the one
 * thing this action gets to decide. MTTA is a claim about who responded and how
 * fast, so letting a caller name somebody else would make it a number anybody
 * could write. `ctx.user.id` is the only answer that survives being asked about
 * later.
 */
export default {
  action: "acknowledgeIncident",
  audit: {
    targetType: "incident",
    snapshot: async (data) => (data.id ? await GetIncidentByIDDashboard({ incident_id: Number(data.id) }) : undefined),
  },
  handler: async (data: Payload, ctx: ActionContext) => {
    const incidentId = Number(data.id);
    if (!Number.isInteger(incidentId) || incidentId <= 0) {
      throw new ActionError(400, "An incident id is required");
    }
    return await AcknowledgeIncident(incidentId, ctx.user.id);
  },
} satisfies ActionDefinition<Payload>;
