import { SetOrgMemberOwner } from "$lib/server/controllers/orgController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface SetOrgMemberOwnerPayload {
  user_id: number;
  is_owner: boolean;
}

/** Promotes or demotes an owner of the current org. The last one cannot be demoted. */
export default {
  action: "setOrgMemberOwner",
  permission: "orgs.members.write",
  schema: (data: Record<string, unknown>): SetOrgMemberOwnerPayload => {
    const userId = Number(data.user_id);
    if (!Number.isInteger(userId) || userId <= 0) throw new ActionError(400, "user_id must be a positive integer");
    return { user_id: userId, is_owner: data.is_owner === true };
  },
  handler: async (data: SetOrgMemberOwnerPayload, ctx: ActionContext) => {
    try {
      await SetOrgMemberOwner(ctx.orgId, data.user_id, data.is_owner);
    } catch (e) {
      throw new ActionError(400, e instanceof Error ? e.message : "Could not change that member");
    }
    return { ok: true };
  },
} satisfies ActionDefinition<SetOrgMemberOwnerPayload>;
