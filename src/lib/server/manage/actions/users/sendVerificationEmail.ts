import { SendVerificationEmail } from "$lib/server/controllers/controller.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

/**
 * Mapped to `null` in ACTION_PERMISSION_MAP, because sending yourself a
 * verification email needs no permission. Sending one to *another* user does,
 * and that check cannot live in the map: it depends on the payload, not just on
 * the action.
 *
 * So the handler makes it, against `ctx.permissions` (already loaded by the
 * pipeline, no second query). This is the pattern for any authorization that
 * depends on what is being acted on rather than which action it is.
 */
export default {
  action: "sendVerificationEmail",
  handler: async (data, ctx) => {
    const toId = parseInt(String(data.toId));
    if (!toId) {
      throw new ActionError(400, "User ID is required");
    }

    // Non-self verification requires users.write permission
    if (toId !== ctx.user.id && !ctx.permissions.has("users.write")) {
      throw new ActionError(403, "You do not have permission to perform this action");
    }

    await SendVerificationEmail(toId, ctx.user.id);
    return { success: true };
  },
} satisfies ActionDefinition;
