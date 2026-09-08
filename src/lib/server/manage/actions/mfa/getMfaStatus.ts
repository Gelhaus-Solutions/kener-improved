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
      // **Whether the policy *requires* a factor of this user, not whether they
      // are allowed one.** A2b split those apart. They were one flag, which
      // meant loosening the policy silently removed two-factor authentication
      // from the people it exempted: an SSO user who wanted a Kener factor as
      // well could not have one, and under `none` nobody could enrol at all.
      //
      // Enrolment is now offered to everyone, always. This only drives the
      // "required by this site" marker, and the refusal to turn a mandatory
      // factor back off.
      mandatory: await MfaAppliesTo(ctx.user.auth_provider),
    };
  },
} satisfies ActionDefinition;
