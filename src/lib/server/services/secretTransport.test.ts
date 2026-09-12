import { describe, it, expect } from "vitest";
import { carriesResolvedSecret, isEncryptedUrl, plaintextSecretRefusal, redirectWouldLeak } from "./secretTransport.js";

const resolved = [{ find: "$TOKEN", replace: "s3cr3t" }];
const unresolved = [{ find: "$TOKEN", replace: undefined }];

describe("carriesResolvedSecret", () => {
  it("is true only when a value actually resolved", () => {
    expect(carriesResolvedSecret(resolved)).toBe(true);
    expect(carriesResolvedSecret(unresolved)).toBe(false);
    expect(carriesResolvedSecret([])).toBe(false);
  });

  it("treats an empty environment value as no secret", () => {
    // `FOO=` substitutes an empty string, which is not a credential and must not
    // fail a check.
    expect(carriesResolvedSecret([{ find: "$TOKEN", replace: "" }])).toBe(false);
  });
});

describe("isEncryptedUrl", () => {
  it("accepts only https and wss", () => {
    expect(isEncryptedUrl("https://example.com")).toBe(true);
    expect(isEncryptedUrl("wss://example.com")).toBe(true);
    expect(isEncryptedUrl("http://example.com")).toBe(false);
    expect(isEncryptedUrl("ws://example.com")).toBe(false);
  });

  it("treats anything it cannot parse as plaintext", () => {
    // Safe direction: a URL whose scheme cannot be read is one this cannot
    // vouch for.
    for (const url of ["", "not a url", "//example.com", undefined, null]) {
      expect(isEncryptedUrl(url)).toBe(false);
    }
  });

  it("does not care about the host, only the scheme", () => {
    // Loopback is deliberately not special-cased: one flag means the same thing
    // in every deployment.
    expect(isEncryptedUrl("http://127.0.0.1:8080")).toBe(false);
    expect(isEncryptedUrl("http://localhost")).toBe(false);
    expect(isEncryptedUrl("http://10.0.0.5")).toBe(false);
  });

  it("is not fooled by https appearing elsewhere in the URL", () => {
    expect(isEncryptedUrl("http://example.com/?next=https://safe.example")).toBe(false);
  });
});

describe("plaintextSecretRefusal", () => {
  const typeData = {};

  it("refuses a resolved secret over http", () => {
    const refusal = plaintextSecretRefusal({ url: "http://example.com", secrets: resolved, typeData });
    expect(refusal).toContain("Refusing to send a secret");
  });

  it("allows a resolved secret over https", () => {
    expect(plaintextSecretRefusal({ url: "https://example.com", secrets: resolved, typeData })).toBeNull();
  });

  it("allows http when there is no resolved secret", () => {
    // A monitor whose `$TOKEN` was never populated has been sending the literal
    // string for months. Refusing on the mention alone would break it.
    expect(plaintextSecretRefusal({ url: "http://example.com", secrets: unresolved, typeData })).toBeNull();
    expect(plaintextSecretRefusal({ url: "http://example.com", secrets: [], typeData })).toBeNull();
  });

  it("allows http when the monitor has opted out", () => {
    const refusal = plaintextSecretRefusal({
      url: "http://internal:8080",
      secrets: resolved,
      typeData: { allowPlaintextSecrets: true },
    });
    expect(refusal).toBeNull();
  });

  it("still refuses loopback without the opt-out", () => {
    expect(plaintextSecretRefusal({ url: "http://127.0.0.1:9000", secrets: resolved, typeData })).not.toBeNull();
  });

  it("refuses a URL it cannot parse when a secret is present", () => {
    expect(plaintextSecretRefusal({ url: "¯\\_(ツ)_/¯", secrets: resolved, typeData })).not.toBeNull();
  });

  it("treats an explicit false opt-out as no opt-out", () => {
    const refusal = plaintextSecretRefusal({
      url: "http://example.com",
      secrets: resolved,
      typeData: { allowPlaintextSecrets: false },
    });
    expect(refusal).not.toBeNull();
  });
});

describe("redirectWouldLeak: the config that looks safe", () => {
  const typeData = {};

  it("blocks an https config redirected down to http", () => {
    // Measured against a real listener: axios follows this by default and
    // carries the Authorization header with it.
    expect(redirectWouldLeak("http://evil.example/downgraded", { secrets: resolved, typeData })).toBe(true);
  });

  it("allows a redirect that stays encrypted", () => {
    expect(redirectWouldLeak("https://example.com/moved", { secrets: resolved, typeData })).toBe(false);
  });

  it("allows a downgrade when there is no secret to lose", () => {
    expect(redirectWouldLeak("http://example.com/moved", { secrets: unresolved, typeData })).toBe(false);
  });

  it("allows a downgrade when the monitor has opted out", () => {
    expect(
      redirectWouldLeak("http://example.com/moved", { secrets: resolved, typeData: { allowPlaintextSecrets: true } }),
    ).toBe(false);
  });

  it("blocks a redirect to something it cannot parse", () => {
    expect(redirectWouldLeak("/relative-and-unparseable", { secrets: resolved, typeData })).toBe(true);
  });
});
