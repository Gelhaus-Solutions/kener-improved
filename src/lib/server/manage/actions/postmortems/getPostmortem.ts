import { GetPostmortemByIncident } from "$lib/server/incidents/postmortem.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  incident_id?: number | string;
}

/**
 * The postmortem for an incident, draft included.
 *
 * Returns null rather than 404 when there is none: "this incident has no
 * postmortem yet" is the ordinary state of most incidents, and an editor that had
 * to treat it as an error would show one on every fresh incident it opened.
 */
export default {
  action: "getPostmortem",
  handler: async (data: Payload) => {
    const incidentId = Number(data.incident_id);
    if (!Number.isInteger(incidentId) || incidentId <= 0) {
      throw new ActionError(400, "An incident id is required");
    }
    return await GetPostmortemByIncident(incidentId);
  },
} satisfies ActionDefinition<Payload>;
