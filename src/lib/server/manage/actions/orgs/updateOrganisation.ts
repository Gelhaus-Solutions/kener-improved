import { UpdateOrganisation } from "$lib/server/controllers/orgController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface UpdateOrganisationPayload {
  name?: string;
  slug?: string;
}

/** Renames the current org, or moves the `/o/<slug>/` path it answers on. */
export default {
  action: "updateOrganisation",
  permission: "orgs.write",
  schema: (data: Record<string, unknown>): UpdateOrganisationPayload => {
    const payload: UpdateOrganisationPayload = {};
    if (data.name !== undefined) payload.name = String(data.name);
    if (data.slug !== undefined) payload.slug = String(data.slug);
    if (payload.name === undefined && payload.slug === undefined) {
      throw new ActionError(400, "Nothing to update");
    }
    return payload;
  },
  handler: async (data: UpdateOrganisationPayload, ctx: ActionContext) => {
    try {
      await UpdateOrganisation(ctx.orgId, data);
    } catch (e) {
      throw new ActionError(400, e instanceof Error ? e.message : "Could not update the organisation");
    }
    return { ok: true };
  },
} satisfies ActionDefinition<UpdateOrganisationPayload>;
