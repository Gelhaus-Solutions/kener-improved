import { RemoveOrgMember } from "$lib/server/controllers/orgController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface RemoveOrgMemberPayload {
  user_id: number;
}

/**
 * Removes a member from the current org, along with the roles they held in it.
 *
 * The user themselves survives: a person is one identity across every org, and
 * what was revoked is their membership of this one.
 */
export default {
  action: "removeOrgMember",
  permission: "orgs.members.write",
  schema: (data: Record<string, unknown>): RemoveOrgMemberPayload => {
    const userId = Number(data.user_id);
    if (!Number.isInteger(userId) || userId <= 0) throw new ActionError(400, "user_id must be a positive integer");
    return { user_id: userId };
  },
  handler: async (data: RemoveOrgMemberPayload, ctx: ActionContext) => {
    try {
      await RemoveOrgMember(ctx.orgId, data.user_id, ctx.user.id);
    } catch (e) {
      throw new ActionError(400, e instanceof Error ? e.message : "Could not remove that member");
    }
    return { ok: true };
  },
} satisfies ActionDefinition<RemoveOrgMemberPayload>;
