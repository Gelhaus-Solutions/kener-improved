import { RemoveOrgDomain } from "$lib/server/controllers/orgController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface RemoveOrgDomainPayload {
  id: number;
}

/** Stops a hostname routing to the current org. Scoped by org id in the delete. */
export default {
  action: "removeOrgDomain",
  permission: "orgs.write",
  schema: (data: Record<string, unknown>): RemoveOrgDomainPayload => {
    const id = Number(data.id);
    if (!Number.isInteger(id) || id <= 0) throw new ActionError(400, "id must be a positive integer");
    return { id };
  },
  handler: async (data: RemoveOrgDomainPayload, ctx: ActionContext) => {
    await RemoveOrgDomain(ctx.orgId, data.id);
    return { ok: true };
  },
} satisfies ActionDefinition<RemoveOrgDomainPayload>;
