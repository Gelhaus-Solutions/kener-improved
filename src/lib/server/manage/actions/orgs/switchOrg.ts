import { SwitchOrg } from "$lib/server/controllers/orgController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface SwitchOrgPayload {
  org_id: number;
}

/**
 * Moves the caller's session into another of their organisations (I3f).
 *
 * **No permission, deliberately.** Membership *is* the check, and it is made
 * against `org_members` inside the controller rather than against a role: a
 * permission would have to be granted per org, so gating this on one would mean
 * a user could be a member of an org they were unable to switch into. There is
 * also nothing to gate - the org a session points at only ever narrows what that
 * session can see, and every screen behind it re-checks permissions in the org
 * it lands in.
 *
 * Not audited: switching is a navigation act, not a change to anything the
 * instance owns. What the caller then *does* in the new org is audited there,
 * with that org's id on the row.
 */
export default {
  action: "switchOrg",
  permission: null,
  audit: false,
  schema: (data: Record<string, unknown>): SwitchOrgPayload => {
    const orgId = Number(data.org_id);
    if (!Number.isInteger(orgId) || orgId <= 0) {
      throw new ActionError(400, "org_id must be a positive integer");
    }
    return { org_id: orgId };
  },
  handler: async (data: SwitchOrgPayload, ctx: ActionContext) => {
    try {
      return await SwitchOrg(ctx.session.id, ctx.user.id, data.org_id);
    } catch (e) {
      // The only thing the controller throws is the membership refusal, and it
      // is a 403: the caller is signed in and simply asked for somewhere they
      // may not go.
      throw new ActionError(403, e instanceof Error ? e.message : "Could not switch organisation");
    }
  },
} satisfies ActionDefinition<SwitchOrgPayload>;
