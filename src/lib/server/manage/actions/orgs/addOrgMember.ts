import { AddOrgMember } from "$lib/server/controllers/orgController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface AddOrgMemberPayload {
  email: string;
  role_id: string;
  is_owner: boolean;
}

/**
 * Adds an existing instance user to the current org.
 *
 * The role is required rather than optional: a member with no role can sign in,
 * switch into this org and then reach nothing at all, which looks like a bug
 * rather than like a decision.
 */
export default {
  action: "addOrgMember",
  permission: "orgs.members.write",
  schema: (data: Record<string, unknown>): AddOrgMemberPayload => {
    const email = String(data.email ?? "").trim();
    const roleId = String(data.role_id ?? "").trim();
    if (!email) throw new ActionError(400, "An email address is required");
    if (!roleId) throw new ActionError(400, "A role is required");
    return { email, role_id: roleId, is_owner: data.is_owner === true };
  },
  handler: async (data: AddOrgMemberPayload, ctx: ActionContext) => {
    try {
      await AddOrgMember(ctx.orgId, data);
    } catch (e) {
      throw new ActionError(400, e instanceof Error ? e.message : "Could not add that member");
    }
    return { ok: true };
  },
} satisfies ActionDefinition<AddOrgMemberPayload>;
