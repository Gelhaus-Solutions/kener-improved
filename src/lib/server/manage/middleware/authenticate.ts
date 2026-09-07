import type { Cookies } from "@sveltejs/kit";
import { GetLoggedInSession, GetUserPermissions } from "$lib/server/controllers/userController.js";
import { ActionError } from "../types.js";
import type { UserRecordPublic } from "$lib/server/types/db";

/**
 * Resolves the caller from the session cookie and loads their permissions.
 *
 * Permissions are fetched here, once, rather than by whoever happens to need
 * them: the inherited chain did the same, and several handlers check a second
 * permission of their own against the set.
 *
 * Throws 401 when there is no valid session. This runs before authorization for
 * the obvious reason, but also before rate limiting, so that one tenant's flood
 * is attributed to them and cannot throttle anyone else.
 */
export async function authenticate(cookies: Cookies): Promise<{
  user: UserRecordPublic;
  permissions: Set<string>;
}> {
  const user = await GetLoggedInSession(cookies);
  if (!user) {
    throw new ActionError(401, "User not logged in");
  }

  const permissions = await GetUserPermissions(user.id);
  return { user, permissions };
}
