import { SavePostmortem, GetPostmortemByIncident } from "$lib/server/incidents/postmortem.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";
import type { PostmortemInput } from "$lib/server/types/postmortem.js";

interface Payload extends PostmortemInput {
  incident_id?: number | string;
}

/**
 * Creates or edits the postmortem. Never publishes one.
 *
 * The separation is the point: publishing is its own action with its own event,
 * so nothing can make a document public as a side effect of somebody hitting
 * save on a draft they were still writing.
 */
export default {
  action: "savePostmortem",
  audit: {
    targetType: "postmortem",
    snapshot: async (data) => (data.incident_id ? await GetPostmortemByIncident(Number(data.incident_id)) : undefined),
  },
  handler: async (data: Payload, ctx: ActionContext) => {
    const incidentId = Number(data.incident_id);
    if (!Number.isInteger(incidentId) || incidentId <= 0) {
      throw new ActionError(400, "An incident id is required");
    }
    return await SavePostmortem(incidentId, data, ctx.user.id);
  },
} satisfies ActionDefinition<Payload>;
