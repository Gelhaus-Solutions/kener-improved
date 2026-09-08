import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { randomBytes, randomInt } from "node:crypto";
import bcrypt from "bcrypt";
import db from "../db/db.js";
import { seal, open } from "../crypto/secretBox.js";
import { GetSiteDataByKey } from "./siteDataController.js";
import { RevokeUserSessions } from "./sessionController.js";
import type { MfaPolicy } from "../types/db.js";

// TOTP second factors.
//
// The two properties that make this worth having, and that are both easy to
// build without:
//
//   **A code is single use.** TOTP codes are valid for a whole 30-second step,
//   and any usable implementation accepts a step either side for clock drift, so
//   a code is live for about 90 seconds. Without a replay guard, a code read over
//   a shoulder or captured by a phishing page works for the rest of that window.
//   `consumeTotpStep` refuses a step at or below the last one spent.
//
//   **The secret is encrypted, not hashed.** Verification recomputes the code
//   from the shared secret, so the server must be able to read it back. That is
//   the opposite of a recovery code, which is compared against typed input and
//   is therefore hashed like a password.

const TOTP_PURPOSE = "user-totp-secret";

/** Steps of clock drift accepted either side of now. */
const DRIFT_WINDOW = 1;

const RECOVERY_CODE_COUNT = 10;

/**
 * Recovery code alphabet.
 *
 * No `0`/`O`, no `1`/`I`/`L`. These are read off a screen and typed back, often
 * from a printout, months later and usually under stress. Ambiguous glyphs turn
 * a working code into a support ticket.
 */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const RECOVERY_BCRYPT_ROUNDS = 10;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The 30-second TOTP step a timestamp falls in. */
export function currentStep(atSeconds: number = nowSeconds()): number {
  return Math.floor(atSeconds / 30);
}

function totpFor(secretBase32: string, label: string, issuer: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

/**
 * The instance's MFA policy.
 *
 * `local_only` by default, so users who authenticate at an identity provider are
 * exempt: their factors are the IdP's business, and demanding a second Kener
 * factor on top of an already-MFA'd SSO login is the kind of friction that gets
 * MFA switched off entirely.
 */
export async function GetMfaPolicy(): Promise<MfaPolicy> {
  try {
    const raw = await GetSiteDataByKey("mfaPolicy");
    if (raw === "none" || raw === "local_only" || raw === "all") return raw;
  } catch (error) {
    console.error("mfa: could not read the policy, defaulting to local_only:", error);
  }
  return "local_only";
}

/** Whether this user is expected to hold a Kener-managed second factor. */
export async function MfaAppliesTo(authProvider: string | null | undefined): Promise<boolean> {
  const policy = await GetMfaPolicy();
  if (policy === "none") return false;
  if (policy === "all") return true;
  return authProvider !== "oidc";
}

export interface MfaStatus {
  enabled: boolean;
  /** True when a secret exists but the user never proved they could use it. */
  pending: boolean;
  confirmed_at: number | null;
  recovery_total: number;
  recovery_unused: number;
}

export async function GetMfaStatus(userId: number): Promise<MfaStatus> {
  const totp = await db.getTotp(userId);
  const counts = await db.countRecoveryCodes(userId);
  return {
    enabled: !!totp?.confirmed_at,
    pending: !!totp && !totp.confirmed_at,
    confirmed_at: totp?.confirmed_at ?? null,
    recovery_total: counts.total,
    recovery_unused: counts.unused,
  };
}

/** True when this user must clear a second factor to sign in. */
export async function RequiresMfa(userId: number): Promise<boolean> {
  const totp = await db.getTotp(userId);
  // An *unconfirmed* secret never gates a login. Enrolment that was abandoned
  // half-way would otherwise lock the user out using a secret their
  // authenticator app never successfully received.
  return !!totp?.confirmed_at;
}

export interface EnrolmentOffer {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

/**
 * Starts enrolment: mints a secret, stores it unconfirmed, and returns what the
 * user needs to add it to their authenticator.
 *
 * Calling it again discards the previous unconfirmed secret, which is what makes
 * "the QR code did not scan, start over" work. It refuses once a factor is
 * confirmed, so it can never silently replace a working one.
 */
export async function BeginMfaEnrolment(userId: number, accountLabel: string, issuer: string): Promise<EnrolmentOffer> {
  const existing = await db.getTotp(userId);
  if (existing?.confirmed_at) {
    throw new Error("Two-factor authentication is already enabled. Disable it first to enrol a new device.");
  }

  // 20 bytes: the RFC 4226 recommendation, and what every authenticator expects.
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  await db.putUnconfirmedTotp(userId, seal(secret, TOTP_PURPOSE), nowSeconds());

  const totp = totpFor(secret, accountLabel, issuer);
  const otpauthUrl = totp.toString();

  return {
    // Shown alongside the QR code so a user whose camera cannot scan it can type
    // the secret in by hand.
    secret,
    otpauthUrl,
    qrDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 }),
  };
}

/**
 * Verifies a code against a user's stored secret and consumes its step.
 *
 * Returns null when the code is wrong, or when it is right but its step has
 * already been spent. The caller cannot tell those apart, and should not: the
 * difference is only interesting to somebody replaying a code.
 */
async function verifyAndConsume(userId: number, code: string, requireConfirmed: boolean): Promise<number | null> {
  const row = await db.getTotp(userId);
  if (!row) return null;
  if (requireConfirmed && !row.confirmed_at) return null;

  const secret = open(row.secret_enc, TOTP_PURPOSE);
  if (!secret) {
    // The row cannot be decrypted: KENER_SECRET_KEY changed, or the value was
    // tampered with. Refusing is right, and it is loud on purpose - the user is
    // about to be locked out and the operator needs to know why.
    console.error(`mfa: the stored secret for user ${userId} could not be decrypted`);
    return null;
  }

  const normalised = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalised)) return null;

  const totp = totpFor(secret, String(userId), "Kener");
  // `delta` is how many steps away the match was: 0 for now, -1 for the previous
  // step, +1 for the next. null when nothing matched.
  const delta = totp.validate({ token: normalised, window: DRIFT_WINDOW });
  if (delta === null) return null;

  const step = currentStep() + delta;

  // The replay guard. A code from a step already spent is refused even though it
  // is arithmetically correct.
  if (!(await db.consumeTotpStep(userId, step, nowSeconds()))) return null;

  return step;
}

/**
 * Completes enrolment.
 *
 * Confirming does two things beyond flipping the flag, and both matter:
 * recovery codes are issued (a factor with no recovery path is a lockout
 * waiting to happen), and **every other session is revoked**. The second is the
 * point of turning MFA on at all: if sessions established before it survived,
 * an attacker already holding one would keep their access and the new factor
 * would protect nothing.
 */
export async function ConfirmMfaEnrolment(
  userId: number,
  code: string,
  keepSessionId?: string,
): Promise<{ recoveryCodes: string[] }> {
  const row = await db.getTotp(userId);
  if (!row) throw new Error("Start enrolment before confirming it");
  if (row.confirmed_at) throw new Error("Two-factor authentication is already enabled");

  const step = await verifyAndConsume(userId, code, false);
  if (step === null) throw new Error("That code is not valid. Check your authenticator and try again.");

  const now = nowSeconds();
  if (!(await db.confirmTotp(userId, now, step))) {
    throw new Error("Two-factor authentication is already enabled");
  }

  const recoveryCodes = await RegenerateRecoveryCodes(userId);
  await RevokeUserSessions(userId, "mfa_enrolled", keepSessionId);

  return { recoveryCodes };
}

/**
 * Checks a code at sign-in.
 *
 * Separate from the enrolment path because this one requires the factor to be
 * confirmed: an unconfirmed secret must never be able to satisfy a login.
 */
export async function VerifyTotpCode(userId: number, code: string): Promise<boolean> {
  return (await verifyAndConsume(userId, code, true)) !== null;
}

function generateRecoveryCode(): string {
  // 10 characters over a 31-character alphabet: about 49 bits. Grouped as
  // XXXXX-XXXXX so it can be read aloud and typed back without losing the place.
  const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]);
  return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
}

/**
 * Issues a fresh set of recovery codes, invalidating any previous set.
 *
 * Returned in plaintext exactly once, here, and stored only as bcrypt hashes.
 * There is deliberately no way to read them back afterwards: a "show my recovery
 * codes again" feature would mean storing them recoverably, which is a set of
 * working credentials sitting in the database.
 */
export async function RegenerateRecoveryCodes(userId: number): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(c, RECOVERY_BCRYPT_ROUNDS)));
  await db.replaceRecoveryCodes(userId, hashes, nowSeconds());
  return codes;
}

/**
 * Spends a recovery code, if it matches an unused one.
 *
 * Every stored hash is compared even after a match, rather than returning early.
 * bcrypt is deliberately slow, so an early return would make the response time
 * depend on which code was presented and on how many the user has left.
 */
export async function VerifyRecoveryCode(userId: number, code: string): Promise<boolean> {
  const normalised = code.trim().toUpperCase().replace(/\s+/g, "");
  if (!normalised) return false;

  const rows = await db.getUnusedRecoveryCodes(userId);
  let matchedId: number | null = null;
  for (const row of rows) {
    if (await bcrypt.compare(normalised, row.code_hash)) {
      if (matchedId === null) matchedId = row.id;
    }
  }
  if (matchedId === null) return false;

  // Conditional in the database, so two requests presenting the same code
  // cannot both succeed.
  return await db.useRecoveryCode(matchedId, nowSeconds());
}

/**
 * Turns the factor off and destroys everything behind it.
 *
 * Recovery codes go too. Leaving them would mean disabling and re-enabling MFA
 * silently resurrected a set of codes the user believed were gone.
 */
export async function DisableMfa(userId: number): Promise<void> {
  await db.deleteTotp(userId);
  await db.deleteRecoveryCodes(userId);
}

/** Random hex, for the sign-in challenge. Exported so the login route can mint one. */
export function challengeNonce(): string {
  return randomBytes(16).toString("hex");
}
