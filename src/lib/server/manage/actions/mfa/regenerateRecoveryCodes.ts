import { RegenerateRecoveryCodes, GetMfaStatus } from "$lib/server/controllers/mfaController.js";
import { requireFreshPassword } from "./requireFreshPassword.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface Payload {
  password: string;
}

/**
 * Issues a fresh set of recovery codes, invalidating the previous set.
 *
 * What a user does after spending one, or after printing them somewhere they no
 * longer trust. Returned in plaintext exactly once.
 */
export default {
  action: "regenerateRecoveryCodes",
  permission: null,
  audit: { targetType: "user_mfa" },
  handler: async (data: Payload, ctx: ActionContext) => {
    await requireFreshPassword(ctx.user.id, data.password, ctx.user.auth_provider);

    const status = await GetMfaStatus(ctx.user.id);
    if (!status.enabled) {
      throw new ActionError(400, "Turn on two-factor authentication before generating recovery codes");
    }

    return { success: true, recoveryCodes: await RegenerateRecoveryCodes(ctx.user.id) };
  },
} satisfies ActionDefinition<Payload>;
