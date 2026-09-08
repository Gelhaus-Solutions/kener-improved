import { GetOrgDetail } from "$lib/server/controllers/orgController.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

/**
 * The org the caller is currently acting in, with the hostnames routed to it.
 *
 * Takes no org id, deliberately: the org is the one the session is in, which the
 * pipeline has already checked membership for. Accepting an id here would mean
 * inventing a second access check, and getting it wrong would be a cross-tenant
 * read of exactly the settings a tenant most wants private.
 */
export default {
  action: "getOrganisation",
  permission: "orgs.read",
  audit: false,
  handler: async (_data: Record<string, unknown>, ctx: ActionContext) => {
    return await GetOrgDetail(ctx.orgId);
  },
} satisfies ActionDefinition;
