import { GetUserSessions } from "$lib/server/controllers/sessionController.js";
import { ResolveSession } from "$lib/server/controllers/sessionController.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

/**
 * The caller's own sessions.
 *
 * Self-scoped by construction: the user id comes from the resolved session, not
 * from the payload, so there is no parameter to tamper with and no permission
 * to get wrong. Anyone signed in may see their own devices.
 */
export default {
  action: "getMySessions",
  // Reading your own sessions needs no permission beyond being signed in. Gating
  // it would mean a user with a narrow role could not check whether somebody
  // else was using their account, which is the one thing this screen is for.
  permission: null,
  audit: false,
  handler: async (_data: Record<string, unknown>, ctx: ActionContext) => {
    const resolved = await ResolveSession(ctx.cookies);
    const sessions = await GetUserSessions(ctx.user.id);

    return {
      // The id is returned so the UI can mark one row "this device" and refuse
      // to offer a revoke that would sign the user out mid-click.
      current_session_id: resolved?.session.id ?? null,
      sessions: sessions.map((s) => ({
        id: s.id,
        issued_at: s.issued_at,
        last_seen_at: s.last_seen_at,
        expires_at: s.expires_at,
        revoked_at: s.revoked_at,
        revoked_reason: s.revoked_reason,
        mfa_level: s.mfa_level,
        ip: s.ip,
        user_agent: s.user_agent,
      })),
    };
  },
} satisfies ActionDefinition;
