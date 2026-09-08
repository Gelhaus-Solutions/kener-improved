import db from "$lib/server/db/db.js";
import { RevokeSession, RevokeUserSessions, ResolveSession } from "$lib/server/controllers/sessionController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface Payload {
  /** One session to end, or omit with `all_others` to end every other device. */
  id?: string;
  all_others?: boolean;
}

/**
 * Ends one of the caller's own sessions, or all of their other ones.
 *
 * **Ownership is checked against the loaded row, never against the payload.**
 * A session id is an opaque string, so without this check any signed-in user
 * could revoke any session on the instance by guessing or by having once seen
 * an id in a log.
 */
export default {
  action: "revokeMySession",
  permission: null,
  audit: { targetType: "session" },
  handler: async (data: Payload, ctx: ActionContext) => {
    const current = await ResolveSession(ctx.cookies);

    if (data.all_others) {
      // Spares the device being used, which is the whole point of the button:
      // "sign out everywhere else" that signed you out too would be useless.
      const revoked = await RevokeUserSessions(ctx.user.id, "revoked_by_user", current?.session.id);
      return { success: true, revoked };
    }

    const id = String(data.id ?? "");
    if (!id) throw new ActionError(400, "A session id is required");

    const session = await db.getLiveSession(id, Math.floor(Date.now() / 1000));
    // The same answer whether the session belongs to someone else or does not
    // exist. Distinguishing them would turn this into an oracle for which
    // session ids are live.
    if (!session || session.user_id !== ctx.user.id) {
      throw new ActionError(404, "Session not found");
    }

    const revoked = await RevokeSession(id, "revoked_by_user");
    return { success: true, revoked: revoked ? 1 : 0 };
  },
} satisfies ActionDefinition<Payload>;
