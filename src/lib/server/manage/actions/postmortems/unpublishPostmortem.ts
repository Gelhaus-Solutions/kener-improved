import { UnpublishPostmortem, GetPostmortemByIncident } from "$lib/server/incidents/postmortem.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface Payload {
  incident_id?: number | string;
  /** True to archive rather than return it to a draft. */
  archive?: boolean;
}

/**
 * Withdraws a published postmortem.
 *
 * Two destinations, because they mean different things: DRAFT is "we are still
 * working on this", ARCHIVED is "this was public and we have withdrawn it". The
 * publication date survives both, so a reader who bookmarked it is not told it
 * never existed.
 */
export default {
  action: "unpublishPostmortem",
  audit: {
    targetType: "postmortem",
    snapshot: async (data) => (data.incident_id ? await GetPostmortemByIncident(Number(data.incident_id)) : undefined),
  },
  handler: async (data: Payload, ctx: ActionContext) => {
    const incidentId = Number(data.incident_id);
    if (!Number.isInteger(incidentId) || incidentId <= 0) {
      throw new ActionError(400, "An incident id is required");
    }
    return await UnpublishPostmortem(incidentId, ctx.user.id, data.archive === true);
  },
} satisfies ActionDefinition<Payload>;
