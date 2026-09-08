import { GetMfaCoverage } from "$lib/server/controllers/mfaController.js";
import type { ActionDefinition, ActionContext, LegacyPayload } from "../../types.js";

/**
 * Who holds a second factor, and who does not.
 *
 * "Which of my users would this stop" is the question a policy change is made in
 * response to, and before this there was no way to ask it: coverage was only
 * visible one account at a time, to the owner of that account.
 *
 * Gated on `users.read` rather than a new permission. It is a property of the
 * user list, and anyone entitled to see who has an account is entitled to see
 * whether that account is protected. It exposes no secret: a boolean per user,
 * never a secret, a code, or a count of recovery codes remaining.
 */
export default {
  action: "getMfaCoverage",
  permission: "users.read",
  handler: async (_data: LegacyPayload, ctx: ActionContext) => {
    return await GetMfaCoverage(ctx.user.id);
  },
} satisfies ActionDefinition<LegacyPayload>;
