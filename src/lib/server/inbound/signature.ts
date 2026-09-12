import crypto from "crypto";
import type { InboundProvider } from "./types.js";

/**
 * H1. Verifying that a payload came from who it claims.
 *
 * **The token already authenticates the sender, so what is this for?** The token
 * is in the URL, and URLs leak in ways bodies do not: proxy logs, browser
 * history, a screenshot in a support ticket, a CI job that prints its
 * configuration. A signature is computed over the body with a secret that was
 * never in the URL, so an attacker who has only seen the URL cannot forge a
 * request. The two together mean a leaked URL alone is not enough to post
 * incidents to somebody's status page.
 *
 * **Optional per endpoint, and enforced when configured.** An endpoint with no
 * signing secret accepts on the token alone, which is what Alertmanager and
 * Uptime Kuma can do. An endpoint *with* one refuses anything unsigned: a
 * verification that can be skipped by omitting the header is not a verification,
 * and that failure mode is the classic one.
 */

/**
 * Where each provider puts its signature.
 *
 * Sentry names its own header. Everything else uses Kener's, because a provider
 * that composes its own payload composes its own headers too, and inventing a
 * per-vendor name for those would be documenting a convention nobody else
 * follows.
 */
const SIGNATURE_HEADERS: Partial<Record<InboundProvider, string>> = {
  SENTRY: "sentry-hook-signature",
};

export const DEFAULT_SIGNATURE_HEADER = "x-kener-signature";

export function signatureHeaderFor(provider: InboundProvider): string {
  return SIGNATURE_HEADERS[provider] ?? DEFAULT_SIGNATURE_HEADER;
}

/** The signature Kener expects for a body: hex HMAC-SHA256, the shape every provider here uses. */
export function signPayload(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export type SignatureVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Checks a presented signature against the body.
 *
 * **Compared with `timingSafeEqual`, and the length check before it is not
 * ceremony.** `timingSafeEqual` throws on mismatched lengths rather than
 * returning false, so a wrong-length signature would be an exception rather than
 * a refusal, and the shape of the failure would differ from a right-length wrong
 * one. Normalising both into the same refusal is the point.
 *
 * A `sha256=` prefix is tolerated because several vendors write one and an
 * operator copying a value between systems should not be defeated by it.
 */
export function verifySignature(rawBody: string, presented: string | null, secret: string): SignatureVerdict {
  if (!presented || presented.trim() === "") return { ok: false, reason: "missing signature" };

  const cleaned = presented.trim().replace(/^sha256=/i, "");
  const expected = signPayload(rawBody, secret);

  const a = Buffer.from(cleaned, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "invalid signature" };

  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "invalid signature" };
}
