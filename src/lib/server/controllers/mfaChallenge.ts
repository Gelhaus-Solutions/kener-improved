import jwt from "jsonwebtoken";
import type { Cookies } from "@sveltejs/kit";
import { redisConnection } from "../redisConnector.js";
import { CookieConfig } from "./commonController.js";
import { challengeNonce } from "./mfaController.js";

// The half-authenticated state between a correct password and a correct code.
//
// The rule this exists to enforce: **a correct password alone must not mint a
// session.** If it did, the second factor would be an optional extra step rather
// than a requirement, and anybody holding the password could simply not perform
// it. So the password gets the user a challenge, and only the code turns that
// challenge into a session.
//
// The challenge is a signed cookie rather than a database row. It carries no
// authority at all - it names a user and expires in five minutes, and the code
// still has to be verified against the stored secret before anything is minted -
// so a row would be persistence for its own sake, and one more thing to clean up.
//
// Attempts are counted in Redis rather than in the cookie for the obvious
// reason: the holder of a cookie can throw it away and start again, so a counter
// they control is not a limit.

const CHALLENGE_COOKIE = "kener-mfa";

/** Long enough to find a phone, short enough that a stolen challenge is stale. */
const CHALLENGE_TTL_SECONDS = 5 * 60;

/**
 * Wrong codes allowed before the challenge is destroyed.
 *
 * Five, and the user has to re-enter their password afterwards. A six-digit code
 * is one in a million per guess, so this is not really about brute force; it is
 * about making an automated attempt loop useless and putting a hard stop on it.
 */
const MAX_ATTEMPTS = 5;

interface ChallengePayload {
  typ: "mfa_challenge";
  uid: number;
  /** Ties the cookie to its Redis attempt counter, and makes each one unique. */
  nonce: string;
}

const DUMMY_SECRET = "kener-dummy-secret";

function secret(): string {
  return process.env.KENER_SECRET_KEY || DUMMY_SECRET;
}

function attemptKey(nonce: string): string {
  return `kener:mfa-attempts:${nonce}`;
}

/**
 * Issues a challenge for a user who has proved their password.
 *
 * The cookie is `sameSite: strict` unlike the session cookie: nothing ever
 * navigates to the MFA step from another site, so there is no flow to break, and
 * strict is simply the better default where it costs nothing.
 */
export function IssueMfaChallenge(cookies: Cookies, userId: number): void {
  const nonce = challengeNonce();
  const token = jwt.sign({ typ: "mfa_challenge", uid: userId, nonce } as ChallengePayload, secret(), {
    expiresIn: CHALLENGE_TTL_SECONDS,
  } as jwt.SignOptions);

  const config = CookieConfig();
  cookies.set(CHALLENGE_COOKIE, token, {
    path: config.path,
    maxAge: CHALLENGE_TTL_SECONDS,
    httpOnly: true,
    secure: config.secure,
    sameSite: "strict",
  });
}

/** Reads and verifies the challenge cookie. */
export function ReadMfaChallenge(cookies: Cookies): { userId: number; nonce: string } | null {
  const raw = cookies.get(CHALLENGE_COOKIE);
  if (!raw) return null;
  try {
    const decoded = jwt.verify(raw, secret());
    if (typeof decoded === "string") return null;
    const payload = decoded as Partial<ChallengePayload>;
    // Same reasoning as the session cookie: every token here is signed with one
    // key, so the type has to be checked or another token would be accepted.
    if (payload.typ !== "mfa_challenge" || typeof payload.uid !== "number" || typeof payload.nonce !== "string") {
      return null;
    }
    return { userId: payload.uid, nonce: payload.nonce };
  } catch {
    return null;
  }
}

export function ClearMfaChallenge(cookies: Cookies): void {
  const config = CookieConfig();
  cookies.delete(CHALLENGE_COOKIE, { path: config.path });
}

/**
 * Records a failed attempt and says whether the challenge is now spent.
 *
 * Fails **closed**: if Redis is unreachable the attempt is treated as the last
 * one. The alternative is a rate limit that disappears exactly when the
 * infrastructure is unhealthy, which is when it is least safe to lose it. The
 * cost of getting it wrong in this direction is that the user re-enters their
 * password, which is the same thing they would do anyway.
 */
export async function RecordMfaFailure(nonce: string): Promise<{ exhausted: boolean; remaining: number }> {
  try {
    const redis = redisConnection();
    const key = attemptKey(nonce);
    const count = await redis.incr(key);
    // Only on the first failure, so the window cannot be extended by failing
    // repeatedly.
    if (count === 1) await redis.expire(key, CHALLENGE_TTL_SECONDS);
    const remaining = Math.max(0, MAX_ATTEMPTS - count);
    return { exhausted: count >= MAX_ATTEMPTS, remaining };
  } catch (error) {
    console.error("mfa: could not count a failed attempt, ending the challenge:", error);
    return { exhausted: true, remaining: 0 };
  }
}

/** Drops the attempt counter once a challenge is finished with. */
export async function ClearMfaAttempts(nonce: string): Promise<void> {
  try {
    await redisConnection().del(attemptKey(nonce));
  } catch {
    // The key expires on its own. Nothing depends on this succeeding.
  }
}

export { MAX_ATTEMPTS as MFA_MAX_ATTEMPTS, CHALLENGE_COOKIE as MFA_CHALLENGE_COOKIE };
