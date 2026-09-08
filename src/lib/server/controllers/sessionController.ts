import { nanoid } from "nanoid";
import type { Cookies } from "@sveltejs/kit";
import jwt from "jsonwebtoken";
import db from "../db/db.js";
import { CookieConfig } from "./commonController.js";
import type { SessionRecord, UserRecordPublic } from "../types/db.js";

// Sessions: minting them, resolving them, and ending them.
//
// The rule the whole file is built on: **the session row is the authority, and
// the cookie is only a claim about which row to look at.** Every authenticated
// request loads the row and checks that it is not revoked, not expired, and
// still matches the user's permission epoch. That is what makes revoking a
// session, deactivating a user or changing a role take effect on the *next
// request* rather than whenever a token happens to expire.
//
// What this replaced is worth stating, because it explains why the design is
// deliberately unclever: a JWT signed over the entire user record with
// `expiresIn: "1y"` and no server-side record at all. The token was the
// authority, so nothing could be revoked, logging out only deleted the
// browser's copy, and a demoted admin kept their old permissions for a year.
//
// **There is no refresh token, and that is a decision rather than an omission.**
// Refresh tokens exist to let an access token be validated without touching the
// database. This design reads the session row on every request anyway - it
// replaces the `getUserByEmail` the old code already did, so it costs nothing
// new - and once the row is being read, a short access token buys nothing that
// `revoked_at` does not already give, immediately rather than within a window.
// The rotating-refresh machinery would only pay for itself in a design where
// the refresh cookie is transmitted rarely, which a cookie-based server-rendered
// app cannot arrange without redirecting through a refresh endpoint on every
// page load.

/** How long a session lasts without any re-authentication. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * How stale `last_seen_at` may get.
 *
 * The point of the throttle is that an active session must not turn every
 * request into a write. A minute of staleness is invisible on the "last active"
 * column this feeds, and it takes the write off the hot path entirely.
 */
const TOUCH_INTERVAL_SECONDS = 60;

/** The cookie the session id travels in. Unchanged from before, deliberately. */
export const SESSION_COOKIE = "kener-user";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * What the cookie carries.
 *
 * Identifiers only. The user record is emphatically **not** in here: it used to
 * be, which meant every signed-in browser held a self-certifying copy of that
 * user's email, name, roles and active flag that stayed valid for a year after
 * any of them changed.
 *
 * `uid` and `epoch` are carried alongside `sid` even though both could be read
 * from the session row, because they let a mismatched token be rejected before
 * anything is trusted, and they make the failure legible in a log.
 */
export interface SessionTokenPayload {
  typ: "session";
  sid: string;
  uid: number;
  epoch: number;
}

const DUMMY_SECRET = "kener-dummy-secret";

function secret(): string {
  return process.env.KENER_SECRET_KEY || DUMMY_SECRET;
}

function signSessionToken(payload: SessionTokenPayload, expiresInSeconds: number): string {
  return jwt.sign(payload, secret(), { expiresIn: expiresInSeconds } as jwt.SignOptions);
}

/**
 * Reads the cookie, verifying the signature.
 *
 * `typ` is checked, which is not ceremony: every other token in this codebase is
 * signed with the same key, so without it a password-reset link or an invitation
 * token would be accepted as a session cookie. It would fail at the session
 * lookup, but "fails later for an unrelated reason" is not a security property.
 */
export function readSessionToken(raw: string): SessionTokenPayload | null {
  try {
    const decoded = jwt.verify(raw, secret());
    if (typeof decoded === "string") return null;
    const payload = decoded as Partial<SessionTokenPayload>;
    if (payload.typ !== "session" || typeof payload.sid !== "string" || typeof payload.uid !== "number") return null;
    return {
      typ: "session",
      sid: payload.sid,
      uid: payload.uid,
      epoch: typeof payload.epoch === "number" ? payload.epoch : 0,
    };
  } catch {
    return null;
  }
}

export interface CreateSessionInput {
  userId: number;
  ip?: string | null;
  userAgent?: string | null;
  /** A2 sets this when the sign-in actually cleared a second factor. */
  mfaLevel?: string;
  activeOrgId?: number | null;
}

/**
 * Mints a session and returns the cookie value to set.
 *
 * The epoch is read at mint time and frozen into both the row and the token, so
 * a permission change made a moment later invalidates this session like any
 * other.
 */
export async function CreateSession(input: CreateSessionInput): Promise<{
  sessionId: string;
  token: string;
  cookieConfig: ReturnType<typeof CookieConfig>;
}> {
  const now = nowSeconds();
  // 32 characters of the nanoid alphabet: ~190 bits. The id is a bearer
  // reference to a live session, so it is sized like a secret even though the
  // signed cookie means guessing one is not by itself enough.
  const sessionId = nanoid(32);
  const epoch = await db.getUserSessionEpoch(input.userId);
  const expiresAt = now + SESSION_TTL_SECONDS;

  await db.createSession({
    id: sessionId,
    user_id: input.userId,
    active_org_id: input.activeOrgId ?? null,
    issued_at: now,
    last_seen_at: now,
    expires_at: expiresAt,
    epoch,
    mfa_level: input.mfaLevel ?? "none",
    ip: input.ip ?? null,
    // Truncated to the column width. A user agent is a diagnostic, and a
    // ridiculous one must not fail a login.
    user_agent: input.userAgent ? input.userAgent.slice(0, 512) : null,
  });

  const token = signSessionToken({ typ: "session", sid: sessionId, uid: input.userId, epoch }, SESSION_TTL_SECONDS);
  return { sessionId, token, cookieConfig: CookieConfig() };
}

export interface ResolvedSession {
  session: SessionRecord;
  user: UserRecordPublic;
}

/**
 * Resolves the caller from the session cookie, or null.
 *
 * Every reason to refuse is treated the same way and returns null: a caller
 * who is not signed in has no business learning *why* the cookie they hold is
 * not good enough.
 *
 * The order matters for cost, not for correctness. The signature is checked
 * first because it needs no database at all, so a forged or stale cookie is
 * rejected without a query.
 */
export async function ResolveSession(cookies: Cookies): Promise<ResolvedSession | null> {
  const raw = cookies.get(SESSION_COOKIE);
  if (!raw) return null;

  const payload = readSessionToken(raw);
  if (!payload) return null;

  const now = nowSeconds();
  const session = await db.getLiveSession(payload.sid, now);
  if (!session) return null;

  // The token names a different user than the row does. Not reachable without
  // the signing key, so reaching it means something is badly wrong.
  if (session.user_id !== payload.uid) return null;

  // Permissions changed since this session was minted. One integer comparison,
  // against a value the session query already joined in, and it is what makes a
  // role change take effect on the next request without adding a permissions
  // read to every request.
  //
  // Checked before the user is loaded: a session that is not going to be
  // honoured should not cost the queries needed to describe who holds it.
  if (session.epoch !== session.user_epoch) {
    // Recorded rather than merely refused, so the session list can say why the
    // user was signed out instead of leaving it looking like an expiry.
    await db.revokeSession(session.id, "epoch_changed", now);
    return null;
  }
  if (!session.user_is_active) return null;

  // Looked up by id, never by email. The old code re-fetched by email, which
  // was a latent identity bug the moment OIDC could change an address: the
  // session would silently follow whoever held that email next.
  const user = await db.getUserById(session.user_id);
  if (!user) return null;
  if (!user.is_active) return null;

  // Throttled inside the query; see the repository.
  await db.touchSession(session.id, now, now - TOUCH_INTERVAL_SECONDS);

  return { session, user };
}

/**
 * Ends the session the caller is holding.
 *
 * Server-side first, then the cookie. If the process died between the two the
 * session would still be revoked, which is the direction that fails safely; the
 * reverse would leave a browser signed out of a session that still worked.
 */
export async function EndSession(cookies: Cookies, reason = "logout"): Promise<void> {
  const raw = cookies.get(SESSION_COOKIE);
  if (raw) {
    const payload = readSessionToken(raw);
    if (payload) {
      try {
        await db.revokeSession(payload.sid, reason, nowSeconds());
      } catch (error) {
        // Clearing the cookie still has to happen. A revoke that failed is
        // recoverable by the user signing out again; a cookie left in place
        // after the user pressed "log out" is not something they can fix.
        console.error("session: could not revoke on logout:", error);
      }
    }
  }
  const config = CookieConfig();
  cookies.delete(config.name, { path: config.path });
}

export async function RevokeSession(sessionId: string, reason: string): Promise<boolean> {
  return await db.revokeSession(sessionId, reason, nowSeconds());
}

export async function RevokeUserSessions(userId: number, reason: string, exceptSessionId?: string): Promise<number> {
  return await db.revokeUserSessions(userId, reason, nowSeconds(), exceptSessionId);
}

/**
 * Raises the MFA level recorded on a session.
 *
 * Called when the user proves a factor, which is how step-up auth becomes
 * possible later without a new table: gating a sensitive action is then a check
 * on this column.
 */
export async function setSessionMfa(sessionId: string, level: string): Promise<void> {
  await db.setSessionMfaLevel(sessionId, level);
}

export async function GetUserSessions(userId: number): Promise<SessionRecord[]> {
  return await db.getSessionsForUser(userId);
}

/**
 * Invalidates every session a user holds by moving their permission epoch on.
 *
 * Call this from anything that changes what a user may do. It is one write
 * regardless of how many sessions exist, and unlike revoking them individually
 * it also catches a session created concurrently with the change.
 *
 * Never throws: a permission change must not fail because the invalidation did.
 * The cost of a swallowed failure is a stale session until it expires, which is
 * strictly better than the change itself rolling back.
 */
export async function BumpUserEpoch(userId: number): Promise<void> {
  try {
    await db.bumpUserSessionEpoch(userId);
  } catch (error) {
    console.error(`session: could not bump the epoch for user ${userId}; their sessions may be stale:`, error);
  }
}
