import { describe, it, expect } from "vitest";
import {
  DEFAULT_SIGNATURE_HEADER,
  signPayload,
  signatureHeaderFor,
  verifySignature,
} from "./signature.js";

/**
 * H1's signature check.
 *
 * The assertions that matter are the refusals. A verifier that accepts a correct
 * signature but also accepts a missing one is worse than no verifier at all,
 * because the endpoint's screen says it is protected. So every way of not
 * presenting a real signature gets its own test.
 */

const SECRET = "s3cr3t-shared-with-the-sender";
const BODY = '{"alerts":[{"status":"firing","fingerprint":"abc"}]}';

describe("verifySignature", () => {
  it("accepts a signature computed over the same body", () => {
    expect(verifySignature(BODY, signPayload(BODY, SECRET), SECRET)).toEqual({ ok: true });
  });

  it("tolerates a sha256= prefix, which several vendors write", () => {
    expect(verifySignature(BODY, `sha256=${signPayload(BODY, SECRET)}`, SECRET)).toEqual({ ok: true });
  });

  it("refuses a missing signature", () => {
    // The classic failure: a check that can be skipped by omitting the header.
    expect(verifySignature(BODY, null, SECRET).ok).toBe(false);
    expect(verifySignature(BODY, "", SECRET).ok).toBe(false);
    expect(verifySignature(BODY, "   ", SECRET).ok).toBe(false);
  });

  it("refuses a signature made with a different secret", () => {
    expect(verifySignature(BODY, signPayload(BODY, "wrong-secret"), SECRET).ok).toBe(false);
  });

  it("refuses a correct signature over a different body", () => {
    // A replayed signature from another request must not authorise this one.
    const other = '{"alerts":[{"status":"resolved","fingerprint":"abc"}]}';
    expect(verifySignature(BODY, signPayload(other, SECRET), SECRET).ok).toBe(false);
  });

  it("refuses rather than throwing on a wrong-length signature", () => {
    // `timingSafeEqual` throws on mismatched lengths, so without the length
    // guard this would be an exception instead of a refusal, and a short
    // signature would fail differently from a wrong one.
    expect(() => verifySignature(BODY, "abc", SECRET)).not.toThrow();
    expect(verifySignature(BODY, "abc", SECRET).ok).toBe(false);
  });

  it("is sensitive to a single flipped character", () => {
    const good = signPayload(BODY, SECRET);
    const flipped = (good[0] === "a" ? "b" : "a") + good.slice(1);
    expect(verifySignature(BODY, flipped, SECRET).ok).toBe(false);
  });
});

describe("signatureHeaderFor", () => {
  it("uses Sentry's own header name", () => {
    expect(signatureHeaderFor("SENTRY")).toBe("sentry-hook-signature");
  });

  it("uses Kener's header for everything that composes its own request", () => {
    for (const provider of ["ALERTMANAGER", "GRAFANA", "CLOUDWATCH", "UPTIME_KUMA", "GENERIC"] as const) {
      expect(signatureHeaderFor(provider), provider).toBe(DEFAULT_SIGNATURE_HEADER);
    }
  });
});
