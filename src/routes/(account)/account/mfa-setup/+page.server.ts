import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import serverResolve from "$lib/server/resolver.js";
import { GetLoggedInSessionFull } from "$lib/server/controllers/userController.js";
import { RequiresMfaEnrolment, PasswordlessEnrolmentAllowed } from "$lib/server/controllers/mfaController.js";

/**
 * Forced enrolment, for a user the MFA policy applies to who has no factor yet.
 *
 * It lives in `(account)` rather than `(manage)` on purpose. The guard that
 * sends people here is on the `(manage)` layout, so an enrolment page inside
 * that group would have to special-case itself out of its own guard, and would
 * render inside an admin shell whose every link goes somewhere the user is not
 * allowed to be. Here there is no guard to escape and no misleading navigation.
 *
 * Reaching it when nothing is owed redirects away, so it never becomes a second,
 * unguarded route to enrolment: the account dialog stays the place a user who is
 * *not* being forced turns MFA on.
 */
export const load: PageServerLoad = async ({ cookies }) => {
  const resolved = await GetLoggedInSessionFull(cookies);
  if (!resolved) {
    throw redirect(302, serverResolve("/account/signin"));
  }

  const { user, session } = resolved;

  if (!(await RequiresMfaEnrolment(user.auth_provider, user.id, session.mfa_level))) {
    throw redirect(302, serverResolve("/manage/app/site-configurations"));
  }

  return {
    email: user.email,
    // An OIDC account has no password, so the form must not ask for one. The
    // server makes the same determination independently; this only decides
    // whether the field is rendered.
    needsPassword: !(await PasswordlessEnrolmentAllowed(user.id, user.auth_provider)),
  };
};
