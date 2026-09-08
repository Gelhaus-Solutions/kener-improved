import { GetOrgMembers } from "$lib/server/controllers/orgController.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

/** Who belongs to the current org, and what they hold in it. */
export default {
  action: "getOrgMembers",
  permission: "orgs.members.read",
  audit: false,
  handler: async (_data: Record<string, unknown>, ctx: ActionContext) => {
    return await GetOrgMembers(ctx.orgId);
  },
} satisfies ActionDefinition;
