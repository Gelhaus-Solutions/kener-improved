/**
 * Recursive redaction for anything on its way into the audit log.
 *
 * The audit log is read by more people than the tables it describes, kept longer
 * than they are, and on Postgres cannot be edited afterwards. A secret that
 * lands in it is a secret that stays there. So redaction is applied to every
 * captured value, and the list is shared rather than per-action, because a
 * per-action list is a list somebody forgets to update.
 *
 * Matching is on the key name, case-insensitively, by substring. That is
 * deliberately over-eager: redacting a harmless field called `code` costs a
 * slightly less useful log entry, while missing one called `oidc_client_secret`
 * costs a leaked credential. Only one of those is recoverable.
 */
const SECRET_KEY_PATTERNS = [
  "password",
  "client_secret",
  "apikey",
  "api_key",
  "hashed_key",
  "secret",
  "token",
  "code",
  "base64",
  "authorization",
  "cookie",
  "credential",
  "private",
  "salt",
  "signature",
];

export const REDACTED = "[redacted]";

// Deep structures in an audit row are almost always a mistake (an entire image
// payload, a full monitor config). Cap the walk rather than trusting callers.
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 2000;

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p));
}

/** Returns a copy of `value` with anything secret-looking replaced. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (depth >= MAX_DEPTH) return "[depth limit]";

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`...${value.length - MAX_ARRAY} more`);
    return out;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }

  // Functions, symbols, bigints: not audit material.
  return String(value);
}

/**
 * Shallow diff of two snapshots, redacted.
 *
 * Only keys whose value actually changed survive, which is what keeps the JSON
 * columns readable: an update that touched one field should not store the whole
 * record twice. Comparison is by serialised value, so nested objects count as
 * changed when anything inside them differs, and the whole nested value is kept
 * on both sides rather than trying to diff recursively. Reviewers want to see
 * the field as it was and as it is, not a patch.
 */
export function diffSnapshots(
  before: unknown,
  after: unknown,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b = (redact(before) ?? {}) as Record<string, unknown>;
  const a = (redact(after) ?? {}) as Record<string, unknown>;
  if (typeof b !== "object" || typeof a !== "object") return null;

  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const bv = JSON.stringify(b[key] ?? null);
    const av = JSON.stringify(a[key] ?? null);
    if (bv !== av) {
      changedBefore[key] = b[key] ?? null;
      changedAfter[key] = a[key] ?? null;
    }
  }

  if (Object.keys(changedAfter).length === 0) return null;
  return { before: changedBefore, after: changedAfter };
}

/** JSON for a text column, or null. Never throws on a cyclic structure. */
export function toJsonColumn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "value could not be serialised" });
  }
}
