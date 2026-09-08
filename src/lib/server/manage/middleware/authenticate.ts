import type { Cookies } from "@sveltejs/kit";
import { GetUserPermissions } from "$lib/server/controllers/userController.js";
import { ResolveSession } from "$lib/server/controllers/sessionController.js";
import { ActionError } from "../types.js";
import { DEFAULT_ORG_ID, runWithOrg } from "$lib/server/db/orgContext.js";
import type { SessionRecord, UserRecordPublic } from "$lib/server/types/db";

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
  session: SessionRecord;
}> {
  // `ResolveSession` rather than `GetLoggedInSession`, which is a wrapper over
  // it that discards the row. The session itself is needed twice downstream -
  // A2b reads `mfa_level` to decide whether enrolment is still outstanding, and
  // confirming enrolment needs the id to spare the caller's own session - and
  // resolving it once here is cheaper than each of them resolving it again.
  const resolved = await ResolveSession(cookies);
  if (!resolved) {
    throw new ActionError(401, "User not logged in");
  }

  // I3d: permissions are per-org, so they have to be read in the org this
  // session acts in.
  //
  // The request is still in the *host-derived* org at this point - the default
  // one, for any install without a custom domain - and roles live in
  // `users_roles`, which is per-org. Resolving them here without the session's
  // org would give an operator who belongs only to a second org an empty
  // permission set, and every action would 403 with "missing permission" rather
  // than anything that points at the real cause.
  //
  // This deliberately does not check membership; `requireOrg` does that a moment
  // later and is the one place entitled to. Reading permissions for an org the
  // user is not a member of simply finds none, which is the safe direction.
  const orgId = resolved.session.active_org_id ?? DEFAULT_ORG_ID;
  const permissions = await runWithOrg(orgId, () => GetUserPermissions(resolved.user.id));
  return { user: resolved.user, permissions, session: resolved.session };
}
