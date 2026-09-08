import { ConfirmMfaEnrolment } from "$lib/server/controllers/mfaController.js";
import { setSessionMfa } from "$lib/server/controllers/sessionController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface Payload {
  code: string;
}

/**
 * Completes enrolment and hands back the recovery codes, once.
 *
 * Confirming revokes the user's other sessions. That is the point of turning MFA
 * on: a session established before the factor existed would otherwise keep
 * working, so an attacker already holding one would be entirely unaffected by
 * the user "securing" their account.
 *
 * The caller's own session is spared and raised to `mfa_level: "totp"`, because
 * they have just demonstrated the factor.
 */
export default {
  action: "confirmMfaEnrolment",
  permission: null,
  audit: { targetType: "user_mfa" },
  handler: async (data: Payload, ctx: ActionContext) => {
    const code = String(data.code ?? "").trim();
    if (!code) throw new ActionError(400, "Enter the code from your authenticator app");

    // The session comes from the context now: `authenticate` already resolved it
    // for A2b's enrolment guard, so re-resolving it here would be a second read
    // of the same row within one request.
    let recoveryCodes: string[];
    try {
      ({ recoveryCodes } = await ConfirmMfaEnrolment(ctx.user.id, code, ctx.session.id));
    } catch (error) {
      throw new ActionError(400, error instanceof Error ? error.message : "Could not confirm enrolment");
    }

    await setSessionMfa(ctx.session.id, "totp");

    // Shown once and never retrievable: they are stored only as bcrypt hashes.
    return { success: true, recoveryCodes };
  },
} satisfies ActionDefinition<Payload>;
