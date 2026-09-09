import { DeletePostmortem, GetPostmortemByIncident } from "$lib/server/incidents/postmortem.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  incident_id?: number | string;
}

/** Removes the postmortem entirely. For a draft nobody wants; archiving is for one that was public. */
export default {
  action: "deletePostmortem",
  audit: {
    targetType: "postmortem",
    snapshot: async (data) => (data.incident_id ? await GetPostmortemByIncident(Number(data.incident_id)) : undefined),
  },
  handler: async (data: Payload) => {
    const incidentId = Number(data.incident_id);
    if (!Number.isInteger(incidentId) || incidentId <= 0) {
      throw new ActionError(400, "An incident id is required");
    }
    return await DeletePostmortem(incidentId);
  },
} satisfies ActionDefinition<Payload>;
