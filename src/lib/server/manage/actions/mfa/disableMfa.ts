import { DisableMfa, GetMfaStatus, MfaAppliesTo } from "$lib/server/controllers/mfaController.js";
import { requireFreshPassword } from "./requireFreshPassword.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface Payload {
  password: string;
}

/**
 * Turns the second factor off, destroying the secret and every recovery code.
 *
 * Password-guarded like enrolment, and for the sharper reason: this is the
 * action that *removes* a protection, so an unlocked browser must not be enough
 * to perform it.
 *
 * **Refused outright when the policy requires a factor of this user.** The
 * account dialog already hides the button, but hiding a control is not
 * enforcement, and without this the round trip would be: disable the factor,
 * get bounced straight into forced enrolment on the next request, having
 * destroyed a working set of recovery codes on the way. Loosen the policy first.
 */
export default {
  action: "disableMfa",
  permission: null,
  audit: { targetType: "user_mfa" },
  handler: async (data: Payload, ctx: ActionContext) => {
    if (await MfaAppliesTo(ctx.user.auth_provider)) {
      throw new ActionError(400, "This site requires two-factor authentication, so it cannot be turned off.");
    }

    await requireFreshPassword(ctx.user.id, data.password, ctx.user.auth_provider);
    await DisableMfa(ctx.user.id);
    return { success: true, status: await GetMfaStatus(ctx.user.id) };
  },
} satisfies ActionDefinition<Payload>;
