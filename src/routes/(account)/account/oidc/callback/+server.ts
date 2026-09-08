import { redirect, error } from "@sveltejs/kit";

/** See the identical helper on the sign-in route: an address is never worth failing a login over. */
function safeClientAddress(event: { getClientAddress: () => string }): string | null {
  try {
    return event.getClientAddress();
  } catch {
    return null;
  }
}

import type { RequestHandler } from "./$types";
import {
  GetOidcSettings,
  HandleCallback,
  FindOrCreateOidcUser,
  GenerateOidcSession,
  OidcLoginError,
} from "$lib/server/controllers/oidcController";
import serverResolve from "$lib/server/resolver.js";
import { auditOidcCallback } from "$lib/server/audit/events";

export const GET: RequestHandler = async (event) => {
  const { url, cookies } = event;
  const settings = await GetOidcSettings();
  if (!settings) {
    throw error(404, "OpenID Connect is not configured or not enabled");
  }

  // Check for error response from the provider first, before
  // checking cookies — this way expired cookies don't hide the
  // actual IdP error message.
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    const errorDesc = url.searchParams.get("error_description") || errorParam;
    console.error(`OIDC provider error: ${errorParam} - ${errorDesc}`);
    auditOidcCallback(event, { outcome: "denied", reason: "provider_error" });
    throw redirect(302, serverResolve("/account/signin?oidc_error=provider_error"));
  }

  const expectedState = cookies.get("oidc-state");
  const expectedNonce = cookies.get("oidc-nonce");
  const codeVerifier = cookies.get("oidc-code-verifier");

  const cookiePath = process.env.KENER_BASE_PATH || "/";
  cookies.delete("oidc-state", { path: cookiePath });
  cookies.delete("oidc-nonce", { path: cookiePath });
  cookies.delete("oidc-code-verifier", { path: cookiePath });

  if (!expectedState || !expectedNonce || !codeVerifier) {
    throw error(400, "Missing OIDC session data. Please try logging in again.");
  }

  try {
    const oidcData = await HandleCallback(settings, url, expectedState, expectedNonce, codeVerifier);

    const user = await FindOrCreateOidcUser(settings, oidcData);

    if (!user.is_active) {
      auditOidcCallback(event, {
        outcome: "denied",
        userId: user.id,
        email: user.email,
        reason: "account_deactivated",
      });
      throw redirect(302, serverResolve("/account/signin?oidc_error=account_deactivated"));
    }

    if (!user.role_ids || user.role_ids.length === 0) {
      auditOidcCallback(event, { outcome: "denied", userId: user.id, email: user.email, reason: "no_roles" });
      throw redirect(302, serverResolve("/account/signin?oidc_error=no_roles"));
    }

    auditOidcCallback(event, { outcome: "ok", userId: user.id, email: user.email, reason: "oidc" });

    const { token, cookieConfig } = await GenerateOidcSession(user, {
      ip: safeClientAddress(event),
      userAgent: event.request.headers.get("user-agent"),
      // "idp" rather than "totp": the factor was cleared at the provider, not
      // here. Recording which it was matters for step-up decisions later, and
      // conflating them would claim Kener verified something it did not.
      mfaLevel: oidcData.mfaAsserted ? "idp" : "none",
    });

    cookies.set(cookieConfig.name, token, {
      path: cookieConfig.path,
      maxAge: cookieConfig.maxAge,
      httpOnly: cookieConfig.httpOnly,
      secure: cookieConfig.secure,
      sameSite: cookieConfig.sameSite,
    });

    throw redirect(302, serverResolve("/manage/app/site-configurations"));
  } catch (e) {
    if (e && typeof e === "object" && "status" in e) {
      const status = (e as { status: number }).status;
      if (status >= 300 && status < 400) {
        throw e;
      }
    }

    console.error("OIDC callback error:", e);
    // The OidcLoginError code is the useful part: it distinguishes a
    // misconfigured provider from a user who is simply not provisioned.
    const code = e instanceof OidcLoginError ? e.code : "auth_failed";
    auditOidcCallback(event, { outcome: "error", reason: code });
    throw redirect(302, serverResolve(`/account/signin?oidc_error=${code}`));
  }
};
