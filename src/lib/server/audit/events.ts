import { record } from "./writer.js";
import { currentOrgIdOrDefault } from "../db/orgContext.js";
import { GetNowTimestampUTC } from "../tool.js";
import type { AuditActorType, AuditOutcome } from "../types/db.js";

/**
 * Audit events that happen outside the admin action registry.
 *
 * Everything reachable through `manage/api` is captured by the pipeline
 * middleware with no per-call-site code. These are the ones that are not: they
 * happen before there is a session to attribute them to, which is precisely why
 * they matter. A sign-in log that records only successful sign-ins answers none
 * of the questions it exists to answer.
 *
 * Kept as named helpers rather than raw `record()` calls so the shape of an
 * authentication event is decided once. A call site should not be choosing what
 * `actor_type` a failed login has.
 *
 * **Every row carries an org, resolved here at record time.** These used to pass
 * `org_id: null`, which was silently worse than it looks: `audit_log` is a tenant
 * table, so the Audit Log screen reads it through `where org_id = ?` and a null
 * never matches. From I3c onwards every sign-in, every rejected API key and every
 * OIDC callback was written to a row nobody could see. Caught only when I3b's
 * deferred NOT NULL turned the invisible write into a loud one.
 *
 * The org has to be captured *now* rather than at flush time: `record()` buffers
 * and the flush happens on a timer, long after the request's AsyncLocalStorage
 * context is gone. `currentOrgIdOrDefault` is the right question for all four -
 * these are pre-authentication events, so there is no session to ask, and the
 * hostname the attempt arrived on is exactly the tenant it concerns.
 */

interface RequestBits {
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

function bitsOf(source: {
  request?: Request;
  locals?: { requestId?: string };
  getClientAddress?: () => string;
}): RequestBits {
  let ip: string | null = null;
  try {
    ip = source.getClientAddress?.() ?? null;
  } catch {
    // Some adapters cannot resolve an address. Never worth failing a login over.
  }
  return {
    requestId: source.locals?.requestId ?? null,
    ip,
    userAgent: source.request?.headers.get("user-agent") ?? null,
  };
}

/**
 * A local sign-in attempt.
 *
 * `email` is recorded even when the account does not exist, because "someone
 * tried to sign in as this address 400 times" is the single most useful thing
 * this log can tell an operator. It is not a secret: it is what the attacker
 * typed. `reason` is a short code, never the message shown to the user, so the
 * log stays greppable as the copy changes.
 */
export function auditSignIn(
  source: Parameters<typeof bitsOf>[0],
  args: { outcome: AuditOutcome; email: string; userId?: number | null; reason: string; statusCode: number },
): void {
  const bits = bitsOf(source);
  record({
    org_id: currentOrgIdOrDefault(),
    ts: GetNowTimestampUTC(),
    request_id: bits.requestId,
    actor_type: args.userId ? "user" : "anonymous",
    actor_id: args.userId ? String(args.userId) : null,
    actor_label: args.email || null,
    action: "auth.signIn",
    permission: null,
    target_type: "user",
    target_id: args.userId ? String(args.userId) : args.email || null,
    outcome: args.outcome,
    status_code: args.statusCode,
    ip: bits.ip,
    user_agent: bits.userAgent,
    before_json: null,
    after_json: null,
    meta_json: JSON.stringify({ reason: args.reason }),
  });
}

/** An OIDC callback outcome, including the `OidcLoginError` code when there is one. */
export function auditOidcCallback(
  source: Parameters<typeof bitsOf>[0],
  args: { outcome: AuditOutcome; userId?: number | null; email?: string | null; reason: string },
): void {
  const bits = bitsOf(source);
  record({
    org_id: currentOrgIdOrDefault(),
    ts: GetNowTimestampUTC(),
    request_id: bits.requestId,
    actor_type: (args.userId ? "oidc" : "anonymous") as AuditActorType,
    actor_id: args.userId ? String(args.userId) : null,
    actor_label: args.email ?? null,
    action: "auth.oidcCallback",
    permission: null,
    target_type: "user",
    target_id: args.userId ? String(args.userId) : null,
    outcome: args.outcome,
    status_code: args.outcome === "ok" ? 302 : 302,
    ip: bits.ip,
    user_agent: bits.userAgent,
    before_json: null,
    after_json: null,
    meta_json: JSON.stringify({ reason: args.reason }),
  });
}

/**
 * A rejected API key.
 *
 * Only failures are recorded. Successful API calls are the normal traffic of the
 * product and would swamp the log; a rejected key is a security event. The key
 * itself is never recorded, not even truncated.
 */
export function auditApiKeyAuthFailure(source: Parameters<typeof bitsOf>[0], reason: string, path: string): void {
  const bits = bitsOf(source);
  record({
    org_id: currentOrgIdOrDefault(),
    ts: GetNowTimestampUTC(),
    request_id: bits.requestId,
    actor_type: "api_key",
    actor_id: null,
    actor_label: null,
    action: "auth.apiKey",
    permission: null,
    target_type: null,
    target_id: null,
    outcome: "denied",
    status_code: 401,
    ip: bits.ip,
    user_agent: bits.userAgent,
    before_json: null,
    after_json: null,
    meta_json: JSON.stringify({ reason, path }),
  });
}

/**
 * A key that authenticated but was not allowed to do what it asked.
 *
 * Distinct from an auth failure, and worth its own row: an unknown key is
 * usually a stale config, whereas a known key reaching for a scope it was not
 * granted is either a misconfigured integration or somebody probing what a
 * leaked key can reach. Unlike the auth failure, the key is identified here,
 * because knowing *which* key is the entire value of the row and the id is not
 * a secret.
 */
export function auditApiKeyScopeDenied(
  source: Parameters<typeof bitsOf>[0],
  key: { id: number; name: string },
  required: string | undefined,
  path: string,
  method: string,
): void {
  const bits = bitsOf(source);
  record({
    org_id: currentOrgIdOrDefault(),
    ts: GetNowTimestampUTC(),
    request_id: bits.requestId,
    actor_type: "api_key",
    actor_id: String(key.id),
    actor_label: key.name,
    action: "authz.apiKey",
    permission: required ?? null,
    target_type: null,
    target_id: null,
    outcome: "denied",
    status_code: 403,
    ip: bits.ip,
    user_agent: bits.userAgent,
    before_json: null,
    after_json: null,
    // `required: null` is the unmapped-route case, which is the one an operator
    // most needs to be able to tell apart from an ordinary scope miss.
    meta_json: JSON.stringify({ required: required ?? null, path, method }),
  });
}
