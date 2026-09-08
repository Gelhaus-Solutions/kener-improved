import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

// Reversible encryption for secrets the application has to *use* later.
//
// This is deliberately not hashing. An API key is hashed, because Kener only
// ever needs to confirm one; a webhook signing secret and an OIDC client secret
// must be replayed verbatim to a third party, so they have to come back out.
// That makes them the one category of stored credential that cannot be a digest.
//
// AES-256-GCM, so a tampered ciphertext fails to decrypt rather than decrypting
// to something attacker-chosen. The key is derived from `KENER_SECRET_KEY` via
// HKDF with a per-purpose `info` string: the webhook key and the OIDC key are
// different keys, so a ciphertext lifted from one column cannot be decrypted by
// the code that reads the other.
//
// **The coupling to KENER_SECRET_KEY is not new.** `CreateHash` already HMACs
// every API key with it, so rotating that variable already invalidates every
// API key in the instance. This adds webhook secrets to the same blast radius,
// which is worth stating in the docs but is not a new class of problem.

/** Version prefix, so a future algorithm change can be recognised rather than guessed. */
const VERSION = "v1";

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Matches the fallback in commonController.ts.
 *
 * A missing secret key is already a fatal misconfiguration everywhere else in
 * the product; sharing the fallback means a dev instance behaves consistently
 * rather than half-working.
 */
const DUMMY_SECRET = "kener-dummy-secret";

const keyCache = new Map<string, Buffer>();

function keyFor(purpose: string): Buffer {
  const cached = keyCache.get(purpose);
  if (cached) return cached;

  const master = process.env.KENER_SECRET_KEY || DUMMY_SECRET;
  // HKDF rather than using the variable directly: KENER_SECRET_KEY is an
  // arbitrary human-chosen string, not 32 bytes of entropy, and feeding it
  // straight to AES would silently truncate or pad it.
  const derived = Buffer.from(
    hkdfSync("sha256", Buffer.from(master, "utf8"), Buffer.alloc(0), `kener:${purpose}`, KEY_LENGTH),
  );
  keyCache.set(purpose, derived);
  return derived;
}

/**
 * Clears the derived-key cache.
 *
 * Only for tests, which change `KENER_SECRET_KEY` between cases. Production
 * never rotates the variable inside a running process.
 */
export function resetSecretBoxKeys(): void {
  keyCache.clear();
}

/**
 * Encrypts `plaintext` under a key derived for `purpose`.
 *
 * Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. Self-describing so a
 * column can hold both encrypted and (during a migration) unencrypted values
 * without a second column to say which.
 */
export function seal(plaintext: string, purpose: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", keyFor(purpose), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

/**
 * Reverses `seal`. Returns null on anything that is not a valid ciphertext for
 * this purpose: wrong format, wrong key, or tampered bytes.
 *
 * Null rather than a throw because every caller's correct response is the same -
 * treat the secret as unusable and carry on - and a throw here would take down a
 * whole page load over one unreadable row.
 */
export function open(sealed: string, purpose: string): string | null {
  if (!isSealed(sealed)) return null;
  const [, ivB64, tagB64, dataB64] = sealed.split(".");
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(purpose), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext. Both mean "cannot use this secret",
    // and distinguishing them for the caller would leak which one it was.
    return null;
  }
}

/** True when `value` looks like output of `seal`, whether or not it decrypts. */
export function isSealed(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return false;
  try {
    return (
      Buffer.from(parts[1], "base64url").length === IV_LENGTH &&
      Buffer.from(parts[2], "base64url").length === TAG_LENGTH
    );
  } catch {
    return false;
  }
}

/**
 * Encrypts a value that may already be encrypted.
 *
 * The migration path: a column holding a mix of plaintext (written before this
 * existed) and ciphertext can be read and rewritten without tracking which rows
 * were done.
 */
export function sealIfPlain(value: string, purpose: string): string {
  return isSealed(value) ? value : seal(value, purpose);
}

/**
 * Decrypts a value that may not be encrypted.
 *
 * Returns the input unchanged when it is not a ciphertext, which is what lets a
 * plaintext secret written before this existed keep working until something
 * rewrites it.
 */
export function openOrPlain(value: string, purpose: string): string {
  if (!isSealed(value)) return value;
  return open(value, purpose) ?? "";
}

/**
 * A non-reversible hint, so the UI can show which secret is configured without
 * being able to show the secret.
 *
 * The last four characters only. Enough for a human to match against what they
 * pasted into the receiving system, useless to anyone who does not already have
 * it. Short secrets get nothing rather than most of themselves.
 */
export function secretHint(secret: string): string {
  return secret.length >= 12 ? `…${secret.slice(-4)}` : "…";
}

/** Constant-time string comparison, for comparing signatures. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Length is not secret (a signature's length is fixed and public), but
  // timingSafeEqual throws on a mismatch, so it has to be checked first.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
