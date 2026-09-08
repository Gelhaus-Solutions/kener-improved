import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import serverResolve from "$lib/server/resolver.js";
import db from "$lib/server/db/db.js";
import { CreateSession } from "$lib/server/controllers/sessionController.js";
import { VerifyTotpCode, VerifyRecoveryCode } from "$lib/server/controllers/mfaController.js";
import {
  ReadMfaChallenge,
  ClearMfaChallenge,
  ClearMfaAttempts,
  RecordMfaFailure,
} from "$lib/server/controllers/mfaChallenge.js";
import { auditSignIn } from "$lib/server/audit/events.js";

/**
 * The second step of signing in.
 *
 * Reachable only with a valid challenge cookie, which is only issued after a
 * correct password. Everything else here is about making sure that a wrong code
 * gets a caller no further than a wrong password would.
 */
export const load: PageServerLoad = async ({ cookies }) => {
  const challenge = ReadMfaChallenge(cookies);
  if (!challenge) {
    // No challenge, or it expired. Back to the password step; there is nothing
    // to say here that would not be telling an anonymous caller something.
    throw redirect(302, serverResolve("/account/signin"));
  }
  return {};
};

function safeClientAddress(event: { getClientAddress: () => string }): string | null {
  try {
    return event.getClientAddress();
  } catch {
    return null;
  }
}

export const actions: Actions = {
  default: async (event) => {
    const { request, cookies } = event;

    const challenge = ReadMfaChallenge(cookies);
    if (!challenge) {
      return fail(400, { error: "Your sign-in attempt expired. Please start again." });
    }

    const formData = await request.formData();
    const code = String(formData.get("code") ?? "").trim();
    const mode = String(formData.get("mode") ?? "totp");

    if (!code) {
      return fail(400, { error: "Enter the code from your authenticator app." });
    }

    const user = await db.getUserById(challenge.userId);
    // The account changed between the two steps. Same treatment as a bad code:
    // the caller learns nothing about why.
    if (!user || !user.is_active) {
      ClearMfaChallenge(cookies);
      await ClearMfaAttempts(challenge.nonce);
      return fail(401, { error: "That code is not valid." });
    }

    const passed = mode === "recovery" ? await VerifyRecoveryCode(user.id, code) : await VerifyTotpCode(user.id, code);

    if (!passed) {
      const { exhausted, remaining } = await RecordMfaFailure(challenge.nonce);
      auditSignIn(event, {
        outcome: "denied",
        email: user.email,
        userId: user.id,
        reason: mode === "recovery" ? "bad_recovery_code" : "bad_totp_code",
        statusCode: 401,
      });

      if (exhausted) {
        // The whole challenge is destroyed, not just this attempt. The user
        // re-enters their password, which is the point: it puts a hard stop on
        // an automated loop rather than merely slowing it down.
        ClearMfaChallenge(cookies);
        await ClearMfaAttempts(challenge.nonce);
        return fail(429, { error: "Too many incorrect codes. Please sign in again." });
      }

      return fail(401, {
        error: `That code is not valid. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      });
    }

    // Only now is a session minted.
    ClearMfaChallenge(cookies);
    await ClearMfaAttempts(challenge.nonce);

    auditSignIn(event, {
      outcome: "ok",
      email: user.email,
      userId: user.id,
      reason: mode === "recovery" ? "recovery_code" : "totp",
      statusCode: 302,
    });

    const { token, cookieConfig } = await CreateSession({
      userId: user.id,
      ip: safeClientAddress(event),
      userAgent: request.headers.get("user-agent"),
      // Recorded on the session, which is what makes step-up auth possible later
      // without a new table: a check on this column is the whole mechanism.
      mfaLevel: mode === "recovery" ? "recovery" : "totp",
    });
    cookies.set(cookieConfig.name, token, {
      path: cookieConfig.path,
      maxAge: cookieConfig.maxAge,
      httpOnly: cookieConfig.httpOnly,
      secure: cookieConfig.secure,
      sameSite: cookieConfig.sameSite,
    });

    throw redirect(302, serverResolve("/manage/app/site-configurations"));
  },
};
