import { RevokeUserSessions, BumpUserEpoch } from "$lib/server/controllers/sessionController.js";
import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  user_id: number;
}

/**
 * Signs another user out of everything.
 *
 * The action an operator takes when a laptop is lost or an account is suspected
 * compromised, and the reason this whole item exists: before sessions, there was
 * no way to do this at all short of changing the person's password and waiting
 * for their year-long token to expire.
 *
 * Bumps the epoch as well as revoking the rows. Revoking alone would leave a
 * window where a request already in flight could mint work against the old
 * session; the epoch closes it and also covers a session created concurrently.
 */
export default {
  action: "revokeUserSessions",
  permission: "sessions.admin",
  audit: { targetType: "user" },
  handler: async (data: Payload) => {
    const userId = Number(data.user_id);
    if (!Number.isFinite(userId)) throw new ActionError(400, "user_id is required");

    const user = await db.getUserById(userId);
    if (!user) throw new ActionError(404, "User not found");

    const revoked = await RevokeUserSessions(userId, "revoked_by_admin");
    await BumpUserEpoch(userId);

    return { success: true, revoked };
  },
} satisfies ActionDefinition<Payload>;
