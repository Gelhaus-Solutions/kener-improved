import { DisableMfa, GetMfaStatus } from "$lib/server/controllers/mfaController.js";
import { requireFreshPassword } from "./requireFreshPassword.js";
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
 */
export default {
  action: "disableMfa",
  permission: null,
  audit: { targetType: "user_mfa" },
  handler: async (data: Payload, ctx: ActionContext) => {
    await requireFreshPassword(ctx.user.id, data.password);
    await DisableMfa(ctx.user.id);
    return { success: true, status: await GetMfaStatus(ctx.user.id) };
  },
} satisfies ActionDefinition<Payload>;
