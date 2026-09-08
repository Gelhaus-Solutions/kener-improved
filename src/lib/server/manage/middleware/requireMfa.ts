import { RequiresMfaEnrolment } from "$lib/server/controllers/mfaController.js";
import { ActionError } from "../types.js";
import type { ActionContext } from "../types.js";

/**
 * Blocks the admin API for a user who owes the instance a second factor.
 *
 * **This is what makes `mfaPolicy` enforcement rather than a suggestion.** The
 * layout guard in `(manage)/+layout.server.ts` redirects page loads, but
 * `/manage/api` is a separate entry point that never goes through a layout: a
 * redirected user could keep doing everything their role allows with `curl`, and
 * the policy would be decoration. A guard that only covers the browser is not a
 * guard.
 *
 * Position is deliberate: **after `authenticate`, before `authorize`.** After,
 * because the check needs the user and their session's MFA level. Before,
 * because "you have not enrolled" is true regardless of whether the caller also
 * lacks the permission, and answering 403-for-permission first would send
 * somebody off to fix the wrong thing.
 */

/**
 * The actions an unenrolled user may still call.
 *
 * Exactly the ones enrolment itself needs, and nothing else. Getting this list
 * wrong in the tight direction locks every user out of the only screen that can
 * unlock them, so it is worth reading carefully:
 *
 *   - `getMfaStatus` renders the enrolment page,
 *   - `beginMfaEnrolment` issues the secret and QR code,
 *   - `confirmMfaEnrolment` completes it, at which point the user stops being
 *     blocked and this list stops mattering to them.
 *
 * `disableMfa` and `regenerateRecoveryCodes` are deliberately **not** here.
 * Neither is reachable without a confirmed factor, so a blocked user cannot need
 * them, and listing `disableMfa` would let somebody satisfy the policy and then
 * immediately undo it while still holding the session.
 */
const ENROLMENT_ACTIONS: ReadonlySet<string> = new Set(["getMfaStatus", "beginMfaEnrolment", "confirmMfaEnrolment"]);

/** The code clients match on to know they should send the user to enrolment. */
export const MFA_ENROLMENT_REQUIRED = "mfa_enrolment_required";

export async function requireMfaEnrolment(action: string, ctx: ActionContext): Promise<void> {
  if (ENROLMENT_ACTIONS.has(action)) return;

  const required = await RequiresMfaEnrolment(ctx.user.auth_provider, ctx.user.id, ctx.session.mfa_level);
  if (!required) return;

  throw new ActionError(403, MFA_ENROLMENT_REQUIRED);
}
