import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { describeError } from "./notification_utils.js";
import { GetRequiredSecrets, ReplaceAllOccurrences } from "../tool.js";
import { openOrPlain } from "../crypto/secretBox.js";
import version from "../../version.js";
import type { WebhookEndpointRecord } from "../types/db.js";

// The event-bus webhook sender.
//
// Deliberately separate from `webhook_notification.ts`, which is the trigger
// sender: that one renders a user-supplied Mustache template into an arbitrary
// body and returns a result object nobody retries. This one owns a fixed,
// versioned envelope, signs it, and returns a verdict the delivery ladder acts
// on. Merging them would mean one function with two contracts.

/** The key `secretBox` derives the webhook signing key under. */
export const WEBHOOK_SECRET_PURPOSE = "webhook-endpoint-secret";

/** Bodies are stored on the delivery row for debugging, not archived. */
const MAX_CAPTURED_BODY = 2000;

/**
 * Consecutive failures before Kener stops sending.
 *
 * With the retry ladder this is roughly a week of a dead endpoint before it is
 * switched off, which is long enough that a weekend outage does not cost anyone
 * their integration.
 */
export const AUTO_DISABLE_AFTER_FAILURES = 20;

export interface WebhookEnvelope {
  id: string;
  type: string;
  api_version: string;
  occurred_at: number;
  /** The outbox's total publish order, so an unordered receiver can still sort. */
  seq: number;
  data: {
    object: Record<string, unknown> | null;
    previous: Record<string, unknown> | null;
  };
  diff: Record<string, unknown> | null;
}

export interface WebhookSendResult {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
  /** True when retrying cannot help, so the ladder is skipped. */
  permanent: boolean;
}

/**
 * `Kener-Signature: t=<unix>,v1=<hex>` over `t + "." + rawBody`.
 *
 * The timestamp is inside the signed material, not merely alongside it, which is
 * what makes a receiver's clock-skew check meaningful: without it an attacker
 * could replay yesterday's body with today's timestamp. Receivers should reject
 * a skew over 300 seconds.
 *
 * Several signatures are emitted during a rotation, oldest last. A receiver
 * accepts the request if *any* `v1` matches, which is what lets a secret be
 * changed without dropping a delivery.
 */
export function signPayload(rawBody: string, secrets: string[], timestamp: number): string {
  const signatures = secrets
    .filter((s) => s.length > 0)
    .map((secret) => createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"));
  return [`t=${timestamp}`, ...signatures.map((sig) => `v1=${sig}`)].join(",");
}

/**
 * The secrets an endpoint currently signs with: its own, plus the previous one
 * while a rotation grace period is open.
 */
export function activeSecrets(endpoint: WebhookEndpointRecord, now: number): string[] {
  const secrets = [openOrPlain(endpoint.secret_encrypted, WEBHOOK_SECRET_PURPOSE)];
  if (
    endpoint.previous_secret_encrypted &&
    endpoint.previous_secret_expires_at !== null &&
    endpoint.previous_secret_expires_at > now
  ) {
    secrets.push(openOrPlain(endpoint.previous_secret_encrypted, WEBHOOK_SECRET_PURPOSE));
  }
  return secrets.filter((s) => s.length > 0);
}

/**
 * Address ranges a user-configured endpoint may not reach.
 *
 * Endpoint URLs are typed in by an admin, and an admin is not always the only
 * person who can reach that form. Without this, "http://169.254.169.254/..." is
 * a one-field cloud-credential exfiltration, and "http://localhost:6379" is a
 * way to talk to Redis. The check is on the *resolved address*, not the
 * hostname, because a hostname the attacker controls can simply resolve to
 * 127.0.0.1.
 */
function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true; // RFC1918, loopback, this-network
    if (a === 169 && b === 254) return true; // link-local, including cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    // An IPv4-mapped address is an IPv4 address wearing a hat, and skipping it
    // here would leave the whole guard bypassable with ::ffff:127.0.0.1.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

export interface UrlCheck {
  allowed: boolean;
  reason: string | null;
}

/**
 * Validates a webhook URL, resolving its hostname.
 *
 * `KENER_ALLOW_PRIVATE_WEBHOOKS=true` turns the address check off, which is
 * needed for the very common case of an internal endpoint on the same network.
 * It is opt-in rather than the default because the failure it prevents is
 * silent and severe, and the people who need it know they need it.
 *
 * There is an unavoidable DNS-rebinding window between this check and the
 * request: the name could resolve differently the second time. Closing it
 * entirely means connecting to the vetted address by hand and carrying the TLS
 * SNI ourselves, which is a fetch replacement and not worth it here. The check
 * still stops every non-adversarial mistake and every casual attempt.
 */
export async function checkWebhookUrl(rawUrl: string): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "URL is not valid" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { allowed: false, reason: `Unsupported protocol ${url.protocol}` };
  }

  if (process.env.KENER_ALLOW_PRIVATE_WEBHOOKS === "true") {
    return { allowed: true, reason: null };
  }

  // A literal address needs no lookup, and must not get one: resolving "127.0.0.1"
  // would succeed and tell us nothing new.
  if (isIP(url.hostname)) {
    return isPrivateAddress(url.hostname)
      ? { allowed: false, reason: "URL points at a private or loopback address" }
      : { allowed: true, reason: null };
  }

  try {
    const addresses = await lookup(url.hostname, { all: true });
    if (addresses.length === 0) {
      return { allowed: false, reason: `Could not resolve ${url.hostname}` };
    }
    // Every resolved address, not just the first: a name that returns one public
    // and one private address must not be allowed through on the public one.
    for (const { address } of addresses) {
      if (isPrivateAddress(address)) {
        return { allowed: false, reason: "URL resolves to a private or loopback address" };
      }
    }
    return { allowed: true, reason: null };
  } catch (error) {
    return { allowed: false, reason: `Could not resolve ${url.hostname}: ${describeError(error)}` };
  }
}

/** Parses the stored `[{key, value}]` header list, tolerating anything malformed. */
function parseCustomHeaders(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { key?: string; value?: string }[];
    if (!Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const h of parsed) {
      if (typeof h?.key === "string" && typeof h?.value === "string") out[h.key] = h.value;
    }
    return out;
  } catch {
    // A header list that will not parse is a configuration mistake, not a reason
    // to stop delivering the event.
    console.error("webhook: custom_headers is not valid JSON, ignoring");
    return {};
  }
}

/**
 * Sends one envelope to one endpoint.
 *
 * Never throws; every outcome is a `WebhookSendResult` the delivery ladder can
 * act on. The `permanent` flag is what stops nine hours of retries against an
 * endpoint that is answering 400, or one whose URL was never deliverable.
 */
export async function sendWebhook(
  endpoint: WebhookEndpointRecord,
  envelope: WebhookEnvelope,
  now: number,
): Promise<WebhookSendResult> {
  const check = await checkWebhookUrl(endpoint.url);
  if (!check.allowed) {
    // Permanent: the URL will still be pointing at the same place next time.
    return { ok: false, status: null, body: null, error: check.reason, permanent: true };
  }

  const secrets = activeSecrets(endpoint, now);
  if (secrets.length === 0) {
    // An unreadable secret means KENER_SECRET_KEY changed under the stored
    // ciphertext. Retrying cannot fix it; the endpoint needs a new secret.
    return {
      ok: false,
      status: null,
      body: null,
      error: "Endpoint secret could not be decrypted; re-save the endpoint to set a new one",
      permanent: true,
    };
  }

  const rawBody = JSON.stringify(envelope);
  const timestamp = now;

  // Same `{{ENV_VAR}}` substitution the trigger sender supports, so a header can
  // carry a token that never has to be stored in the database.
  let url = endpoint.url;
  const custom = parseCustomHeaders(endpoint.custom_headers);
  let headerBlob = JSON.stringify(custom);
  for (const secret of GetRequiredSecrets(headerBlob + url)) {
    if (secret.replace === undefined) continue;
    headerBlob = ReplaceAllOccurrences(headerBlob, secret.find, secret.replace);
    url = ReplaceAllOccurrences(url, secret.find, secret.replace);
  }

  const headers: Record<string, string> = {
    ...(JSON.parse(headerBlob) as Record<string, string>),
    // Set after the custom headers, so a misconfigured endpoint cannot override
    // its own signature or content type and silently unsign itself.
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": `Kener/${version()}`,
    "kener-signature": signPayload(rawBody, secrets, timestamp),
    "kener-event-id": envelope.id,
    "kener-event-type": envelope.type,
    "kener-delivery-seq": String(envelope.seq),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeout_ms);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: rawBody,
      signal: controller.signal,
      // A webhook receiver that answers with a redirect is misconfigured, and
      // following one would send a signed body somewhere the admin never named.
      redirect: "manual",
    });

    const text = await response.text().catch(() => "");
    const body = text.length > MAX_CAPTURED_BODY ? text.slice(0, MAX_CAPTURED_BODY) : text;

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status, body, error: null, permanent: false };
    }

    // 4xx except 408 and 429 will say the same thing on every attempt: the
    // receiver has rejected the request, not failed to handle it.
    const permanent =
      response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;

    return {
      ok: false,
      status: response.status,
      body,
      error: `Endpoint responded ${response.status}`,
      permanent,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: null,
      body: null,
      // describeError unwraps undici's nested `cause`, which is where the real
      // reason (ECONNREFUSED, certificate failure) actually lives.
      error: aborted ? `Timed out after ${endpoint.timeout_ms}ms` : describeError(error),
      permanent: false,
    };
  } finally {
    clearTimeout(timer);
  }
}
