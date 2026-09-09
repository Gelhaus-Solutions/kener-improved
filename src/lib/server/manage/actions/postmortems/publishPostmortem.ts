import { PublishPostmortem, GetPostmortemByIncident } from "$lib/server/incidents/postmortem.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface Payload {
  incident_id?: number | string;
}

/** Makes the postmortem public, and mails subscribers if it says to. */
export default {
  action: "publishPostmortem",
  audit: {
    targetType: "postmortem",
    snapshot: async (data) => (data.incident_id ? await GetPostmortemByIncident(Number(data.incident_id)) : undefined),
  },
  handler: async (data: Payload, ctx: ActionContext) => {
    const incidentId = Number(data.incident_id);
    if (!Number.isInteger(incidentId) || incidentId <= 0) {
      throw new ActionError(400, "An incident id is required");
    }
    return await PublishPostmortem(incidentId, ctx.user.id);
  },
} satisfies ActionDefinition<Payload>;
