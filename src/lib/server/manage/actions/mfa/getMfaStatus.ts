import { GetMfaStatus, GetMfaPolicy, MfaAppliesTo } from "$lib/server/controllers/mfaController.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

/**
 * Whether the caller has a second factor, and how many recovery codes are left.
 *
 * Self-scoped: the user id comes from the session, so there is no permission to
 * gate and nothing in the payload to tamper with.
 */
export default {
  action: "getMfaStatus",
  permission: null,
  audit: false,
  handler: async (_data: Record<string, unknown>, ctx: ActionContext) => {
    const status = await GetMfaStatus(ctx.user.id);
    return {
      ...status,
      policy: await GetMfaPolicy(),
      // False for an SSO user under the default policy: their factors are the
      // identity provider's business, so the UI should not offer to enrol one.
      applies: await MfaAppliesTo(ctx.user.auth_provider),
    };
  },
} satisfies ActionDefinition;
