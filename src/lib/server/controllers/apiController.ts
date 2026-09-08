import db from "../db/db.js";
import crypto from "crypto";
import { MaskString, CreateHash } from "./commonController.js";
import { API_KEY_SCOPES, WILDCARD_SCOPE, isKnownScope, parseScopes, scopeSatisfies } from "../../apiScopes.js";
import { redisConnection } from "../redisConnector.js";

interface ApiKeyInput {
  name: string;
  /** Permission ids, or the single entry `*`. Omitted means full access, as before. */
  scopes?: string[];
  /** Days until the key stops authenticating. Omitted or 0 means it never expires. */
  expires_in_days?: number;
}
interface ApiKeyStatusInput {
  id: number;
  status: string;
}

interface ApiKeyDeleteInput {
  id: number;
}

/**
 * Who is asking for a key to be minted.
 *
 * Present so the mint can be capped at the caller's own permissions. Without a
 * ceiling, `api_keys.write` is a privilege-escalation permission: an editor who
 * cannot delete a monitor through the admin UI could mint a `*` key and delete
 * it through the API a second later, which makes the entire role system
 * bypassable in one action.
 */
export interface ApiKeyCaller {
  userId: number;
  permissions: Set<string>;
}

/** What authentication resolves a bearer token to. */
export interface ApiKeyPrincipal {
  id: number;
  name: string;
  scopes: string[];
  /** P4. NULL until orgs exist, and means "the single implicit org". */
  orgId: number | null;
}

const KEY_PREFIX = "kener_";
/** Matches `sessions.last_seen_at`: a minute of staleness is invisible on a "last used" column. */
const TOUCH_INTERVAL_SECONDS = 60;
/** How long a rotated key keeps working while deployments pick up its replacement. */
const ROTATION_GRACE_SECONDS = 24 * 60 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function generateApiKey() {
  const randomKey = crypto.randomBytes(32).toString("hex"); // 64-character hexadecimal string
  return KEY_PREFIX + randomKey;
}

/**
 * The leading, non-secret characters of a key.
 *
 * Six hex characters is 24 bits, which is far too little to help an attacker
 * against a 256-bit key but plenty to let an operator match a key quoted in a
 * log line or a config file against a row in the list.
 */
function keyPrefixOf(apiKey: string): string {
  return apiKey.slice(0, KEY_PREFIX.length + 6);
}

/**
 * Validates a requested scope list and caps it at what the caller may delegate.
 *
 * Three failures, all deliberate 400/403s rather than silent narrowing: an
 * unknown scope is almost always a typo that would otherwise produce a key
 * quietly missing a permission; an empty list is a key that can do nothing, which
 * is never what anybody meant to create; and a scope the caller does not hold is
 * the escalation this function exists to stop.
 */
function resolveScopes(requested: string[] | undefined, caller?: ApiKeyCaller): string[] {
  const scopes = requested === undefined ? [WILDCARD_SCOPE] : Array.from(new Set(requested));

  if (scopes.length === 0) {
    throw new Error("Select at least one scope for the API key");
  }

  const unknown = scopes.filter((s) => !isKnownScope(s));
  if (unknown.length > 0) {
    throw new Error(`Unknown API key scope: ${unknown.join(", ")}`);
  }

  // `*` alongside named scopes is a contradiction the list rendering cannot
  // express honestly, so it collapses to plain full access.
  if (scopes.includes(WILDCARD_SCOPE)) {
    if (caller) {
      // Full access may only be delegated by somebody who actually has full
      // access. Anything less would let a partially privileged user mint a key
      // stronger than themselves.
      const missing = API_KEY_SCOPES.filter((p) => !caller.permissions.has(p.id));
      if (missing.length > 0) {
        throw new Error("You cannot create a full-access API key without holding every permission");
      }
    }
    return [WILDCARD_SCOPE];
  }

  if (caller) {
    const missing = scopes.filter((s) => !caller.permissions.has(s));
    if (missing.length > 0) {
      throw new Error(`You cannot grant a permission you do not hold: ${missing.join(", ")}`);
    }
  }

  return scopes;
}

function resolveExpiry(days: number | undefined): number | null {
  if (days === undefined || days === null || Number(days) === 0) return null;
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("Expiry must be a positive number of days");
  }
  return nowSeconds() + Math.round(n * 24 * 60 * 60);
}

export const CreateNewAPIKey = async (
  data: ApiKeyInput,
  caller?: ApiKeyCaller,
): Promise<{ apiKey: string; name: string; scopes: string[]; expires_at: number | null }> => {
  //data.name cant be empty
  if (!data.name) {
    throw new Error("Name is required");
  }

  // Both of these throw before anything is generated, so a rejected request
  // leaves no half-created key behind.
  const scopes = resolveScopes(data.scopes, caller);
  const expiresAt = resolveExpiry(data.expires_in_days);

  //generate a new key
  const apiKey = generateApiKey();
  const hashed_key = await CreateHash(apiKey);
  //insert into db

  await db.createNewApiKey({
    name: data.name,
    hashed_key: hashed_key,
    masked_key: MaskString(apiKey),
    scopes: JSON.stringify(scopes),
    expires_at: expiresAt,
    created_by: caller?.userId ?? null,
    key_prefix: keyPrefixOf(apiKey),
  });

  return {
    apiKey: apiKey,
    name: data.name,
    scopes,
    expires_at: expiresAt,
  };
};

export const GetAllAPIKeys = async () => {
  return await db.getAllApiKeys();
};

//update status of api key
export const UpdateApiKeyStatus = async (data: ApiKeyStatusInput): Promise<number> => {
  return await db.updateApiKeyStatus(data);
};

export const DeleteApiKey = async (data: ApiKeyDeleteInput): Promise<number> => {
  if (!data.id || Number.isNaN(Number(data.id))) {
    throw new Error("Valid API key id is required");
  }
  return await db.deleteApiKey(Number(data.id));
};

/**
 * Revokes a key permanently.
 *
 * Separate from `UpdateApiKeyStatus`, which is a switch an operator flips back
 * and forth. This one is one-way: authentication rejects a revoked key whatever
 * its status column later says, so an accidental re-activation cannot resurrect
 * a credential somebody decided was burned.
 */
export const RevokeApiKey = async (data: ApiKeyDeleteInput): Promise<number> => {
  if (!data.id || Number.isNaN(Number(data.id))) {
    throw new Error("Valid API key id is required");
  }
  return await db.revokeApiKey(Number(data.id), nowSeconds());
};

/**
 * Rotates a key: mints a replacement and puts the old one on a 24h fuse.
 *
 * The old key is **not** deleted. Rotation exists precisely for the case where
 * the secret is deployed somewhere, and deleting it turns a routine hygiene task
 * into an outage; the grace window is what lets deployments catch up. An
 * operator who has confirmed the new key works can cut the window short with
 * `RevokeApiKey`.
 *
 * The names shuffle rather than duplicate, because `api_keys.name` is UNIQUE
 * upstream and dropping that constraint on SQLite means a table rebuild for no
 * gain. The replacement takes the original name, since that is the one written
 * down in runbooks and referred to in conversation, and the outgoing key becomes
 * "<name> (rotated #<id>)" - unique by construction, and self-explanatory in a list.
 */
export const RotateApiKey = async (
  data: { id: number; scopes?: string[] },
  caller?: ApiKeyCaller,
): Promise<{ apiKey: string; name: string; scopes: string[]; expires_at: number | null }> => {
  if (!data.id || Number.isNaN(Number(data.id))) {
    throw new Error("Valid API key id is required");
  }

  const existing = await db.getApiKeyById(Number(data.id));
  if (!existing) {
    throw new Error("API key not found");
  }
  if (existing.revoked_at) {
    throw new Error("A revoked API key cannot be rotated");
  }

  // Rotation defaults to carrying the existing scopes forward. Passing new ones
  // is how a key is narrowed, and they go through the same ceiling check a fresh
  // mint does - otherwise rotation would be an escalation path around it.
  const requested = data.scopes ?? parseScopes(existing.scopes);
  const scopes = resolveScopes(requested, caller);

  const retiredName = `${existing.name} (rotated #${existing.id})`;
  // The grace window may only shorten the outgoing key's life, never extend it.
  // A key already expiring in an hour must still expire in an hour; rotating it
  // is not a reason to hand it another day.
  const graceUntil = nowSeconds() + ROTATION_GRACE_SECONDS;
  const retiredExpiry = existing.expires_at === null ? graceUntil : Math.min(existing.expires_at, graceUntil);
  await db.retireApiKey(existing.id, retiredName, retiredExpiry);

  const apiKey = generateApiKey();
  await db.createNewApiKey({
    name: existing.name,
    hashed_key: CreateHash(apiKey),
    masked_key: MaskString(apiKey),
    scopes: JSON.stringify(scopes),
    // A rotation inherits no expiry of its own; the outgoing key is the one with
    // the fuse. Carrying the old key's expiry over would make every rotation
    // shorten the replacement's life.
    expires_at: null,
    created_by: caller?.userId ?? null,
    rotated_from: existing.id,
    key_prefix: keyPrefixOf(apiKey),
    org_id: existing.org_id ?? null,
  });

  return { apiKey, name: existing.name, scopes, expires_at: null };
};

/**
 * Resolves a bearer token to the key behind it, or null.
 *
 * Four independent reasons to refuse, and they are all checked here rather than
 * at the call site so that no caller can accidentally honour a key the others
 * reject: the hash must match a row, the row must be ACTIVE, it must not be
 * revoked, and it must not have expired.
 */
export const AuthenticateAPIKey = async (apiKey: string): Promise<ApiKeyPrincipal | null> => {
  const hashed_key = CreateHash(apiKey);
  const record = await db.getApiKeyByHashedKey(hashed_key);
  if (!record) return null;

  if (record.status !== "ACTIVE") return null;
  if (record.revoked_at) return null;
  if (record.expires_at !== null && record.expires_at !== undefined && record.expires_at <= nowSeconds()) return null;

  return {
    id: record.id,
    name: record.name,
    scopes: parseScopes(record.scopes),
    orgId: record.org_id ?? null,
  };
};

/**
 * Whether a key exists and is usable.
 *
 * Kept with its original signature and name because upstream calls it, and a
 * sync should not have to rewrite call sites to keep compiling. Everything that
 * needs to know *what* the key may do calls `AuthenticateAPIKey` instead.
 */
export const VerifyAPIKey = async (apiKey: string): Promise<boolean> => {
  return (await AuthenticateAPIKey(apiKey)) !== null;
};

/** Whether `principal` may perform an action requiring `required`. */
export const ApiKeyHasScope = (principal: ApiKeyPrincipal, required: string): boolean => {
  return scopeSatisfies(principal.scopes, required);
};

/**
 * Records that a key was just used, at most once a minute per key.
 *
 * Two gates, not one. Redis answers "has this key been touched in the last
 * minute" without a database round trip, which is the point: a polling
 * integration would otherwise add a write to every request. The conditional
 * UPDATE behind it is the same guard `touchSession` uses, and it is what keeps
 * the throttle honest when Redis is unavailable - the write degrades to once a
 * minute rather than once a request.
 *
 * Never throws. A "last used" column is diagnostic; failing an authenticated
 * API request because a bookkeeping write failed would be a far worse outcome
 * than a stale timestamp.
 */
export const TouchAPIKey = async (principal: ApiKeyPrincipal, ip: string | null): Promise<void> => {
  const now = nowSeconds();
  try {
    try {
      const gate = await redisConnection().set(`apikey:touch:${principal.id}`, "1", "EX", TOUCH_INTERVAL_SECONDS, "NX");
      // Somebody else already claimed this minute's write.
      if (gate === null) return;
    } catch {
      // Redis is down. Fall through to the database, whose own staleness guard
      // still holds the write rate to once a minute. Failing open here matters:
      // Redis being unavailable must not stop the API from serving requests.
    }
    await db.touchApiKey(principal.id, now, ip, now - TOUCH_INTERVAL_SECONDS);
  } catch (error) {
    console.error("api key: could not record last use:", error);
  }
};
