import { describe, it, expect } from "vitest";
import { assessCertificate, isFiring, isRecovered, tlsEndpointFor, type CertVerdict } from "./certAssessment.js";
import { daysUntil, type CertificateInspection } from "./certificateInspector.js";

/**
 * B7. The rules that decide whether somebody is woken up about a certificate.
 *
 * Two of these are the whole reason the module is separate from the socket:
 * the ORDER of expiry against trust, and what UNREACHABLE means. Both are the
 * kind of thing that looks arbitrary until it pages the wrong person.
 */

const DAY = 86_400_000;
const NOW = new Date("2026-01-15T12:00:00Z");

function reachable(over: Partial<Extract<CertificateInspection, { reachable: true }>> = {}): CertificateInspection {
  const validTo = over.validTo ?? new Date(NOW.getTime() + 90 * DAY);
  return {
    reachable: true,
    validTo,
    validFrom: new Date(NOW.getTime() - 30 * DAY),
    daysRemaining: daysUntil(validTo, NOW),
    issuer: "Example CA",
    subject: "status.example.com",
    authorized: true,
    authorizationError: null,
    selfSigned: false,
    protocol: "TLSv1.3",
    ...over,
  };
}

describe("expiry", () => {
  it("is OK well before the threshold", () => {
    const a = assessCertificate(reachable(), 30);
    expect(a.verdict).toBe("OK");
    expect(a.daysRemaining).toBe(90);
  });

  it("fires once inside the threshold", () => {
    const validTo = new Date(NOW.getTime() + 9 * DAY);
    const a = assessCertificate(reachable({ validTo }), 30);
    expect(a.verdict).toBe("EXPIRING");
    expect(a.detail).toContain("9 day");
  });

  // Truncating rather than rounding: a certificate with 29.9 days left must fire
  // on a "warn at 30" rule, or the warning is held back for most of a day at
  // exactly the moment the operator asked to hear about it.
  it("counts a partial day down, so 29.9 days left fires a 30-day rule", () => {
    const validTo = new Date(NOW.getTime() + 30 * DAY - 3600_000);
    expect(daysUntil(validTo, NOW)).toBe(29);
    expect(assessCertificate(reachable({ validTo }), 30).verdict).toBe("EXPIRING");
  });

  it("separates already-expired from expiring", () => {
    const validTo = new Date(NOW.getTime() - 3 * DAY);
    const a = assessCertificate(reachable({ validTo }), 30);
    expect(a.verdict).toBe("EXPIRED");
    expect(a.detail).toContain("3 day");
  });
});

/**
 * THE ORDERING RULE. An expired certificate ALSO fails chain validation, so a
 * naive implementation that asks about trust first reports every expired
 * certificate as untrusted and sends the operator hunting for a missing
 * intermediate that is not missing.
 */
describe("expiry is assessed before trust", () => {
  it("calls an expired, unvalidatable certificate EXPIRED", () => {
    const validTo = new Date(NOW.getTime() - 1 * DAY);
    const a = assessCertificate(
      reachable({ validTo, authorized: false, authorizationError: "CERT_HAS_EXPIRED" }),
      30,
    );
    expect(a.verdict).toBe("EXPIRED");
    expect(a.verdict).not.toBe("UNTRUSTED");
  });

  it("still reports UNTRUSTED for a valid-dated certificate nobody trusts", () => {
    const a = assessCertificate(reachable({ authorized: false, authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), 30);
    expect(a.verdict).toBe("UNTRUSTED");
    expect(a.detail).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
  });

  // The operator's next action differs: a self-signed certificate is replaced,
  // an unknown-authority one usually needs an intermediate installed.
  it("names self-signed separately from an unvalidatable chain", () => {
    const a = assessCertificate(
      reachable({ authorized: false, authorizationError: "DEPTH_ZERO_SELF_SIGNED_CERT", selfSigned: true }),
      30,
    );
    expect(a.verdict).toBe("UNTRUSTED");
    expect(a.detail).toContain("self-signed");
  });
});

/**
 * THE OTHER RULE. "We could not read it" is neither "it is fine" nor "it is
 * bad". Resolving on it would close every certificate alert the moment a host
 * went down, which is exactly when nobody is looking at certificates; firing on
 * it would page the on-call about TLS during an ordinary outage.
 */
describe("an unreadable certificate is neither firing nor recovering", () => {
  const unreachable: CertificateInspection = { reachable: false, error: "ECONNREFUSED" };

  it("is UNREACHABLE, carrying the reason", () => {
    const a = assessCertificate(unreachable, 30);
    expect(a.verdict).toBe("UNREACHABLE");
    expect(a.detail).toContain("ECONNREFUSED");
    expect(a.daysRemaining).toBeNull();
  });

  it("answers null to firing, which the alerting queue reads as do nothing", () => {
    expect(isFiring("UNREACHABLE")).toBeNull();
  });

  it("does not resolve an open alert", () => {
    expect(isRecovered("UNREACHABLE")).toBe(false);
  });
});

describe("firing and recovery are not each other's negation", () => {
  const verdicts: CertVerdict[] = ["OK", "EXPIRING", "EXPIRED", "UNTRUSTED", "UNREACHABLE"];

  it("fires for every problem and only for problems", () => {
    expect(isFiring("OK")).toBe(false);
    for (const v of ["EXPIRING", "EXPIRED", "UNTRUSTED"] as CertVerdict[]) expect(isFiring(v)).toBe(true);
  });

  it("recovers only on OK", () => {
    for (const v of verdicts) expect(isRecovered(v)).toBe(v === "OK");
  });

  // The gap between them is the whole hysteresis story: exactly one verdict is
  // neither, and it is the one that means "ask again later".
  it("leaves exactly one verdict that is neither firing nor recovering", () => {
    const neither = verdicts.filter((v) => isFiring(v) === null && !isRecovered(v));
    expect(neither).toEqual(["UNREACHABLE"]);
  });
});

/**
 * B7. Which monitors have a certificate worth alerting on.
 *
 * The rule that matters is what returns NULL. A certificate alert configured
 * against a monitor with no TLS is a configuration mistake, and inventing an
 * endpoint for it would inspect a service the monitor does not watch and then
 * report confidently on the wrong thing.
 */
describe("tlsEndpointFor", () => {
  it("reads an SSL monitor's own host and port", () => {
    expect(tlsEndpointFor("SSL", { host: "status.example.com", port: "8443" })).toEqual({
      host: "status.example.com",
      port: 8443,
    });
    expect(tlsEndpointFor("SSL", { host: "status.example.com" })).toEqual({
      host: "status.example.com",
      port: 443,
    });
  });

  it("takes host and port from an https API monitor's URL", () => {
    expect(tlsEndpointFor("API", { url: "https://api.example.com/health" })).toEqual({
      host: "api.example.com",
      port: 443,
    });
    expect(tlsEndpointFor("API", { url: "https://api.example.com:8443/health" })).toEqual({
      host: "api.example.com",
      port: 8443,
    });
  });

  // Inspecting 443 anyway would report on a service this monitor does not
  // watch, and report it as healthy or not with equal confidence.
  it("refuses a plain http API monitor rather than assuming 443", () => {
    expect(tlsEndpointFor("API", { url: "http://api.example.com/health" })).toBeNull();
  });

  it("refuses a gRPC monitor with TLS switched off", () => {
    expect(tlsEndpointFor("GRPC", { host: "grpc.example.com", port: 50051, tls: false })).toBeNull();
    expect(tlsEndpointFor("GRPC", { host: "grpc.example.com", port: 50051, tls: true })).toEqual({
      host: "grpc.example.com",
      port: 50051,
    });
  });

  // A TCP service's TLS port is not knowable, so there is no safe default.
  it("needs an explicit port for TCP and will not guess 443", () => {
    expect(tlsEndpointFor("TCP", { hosts: [{ host: "db.example.com", port: 5432 }] })).toEqual({
      host: "db.example.com",
      port: 5432,
    });
    expect(tlsEndpointFor("TCP", { hosts: [{ host: "db.example.com" }] })).toBeNull();
  });

  it("has nothing to inspect for the monitor types with no TLS", () => {
    for (const type of ["PING", "DNS", "SQL", "GAMEDIG", "HEARTBEAT", "GROUP", "NONE"]) {
      expect(tlsEndpointFor(type, { host: "example.com", url: "https://example.com" }), type).toBeNull();
    }
  });

  it("returns null rather than throwing on an unparseable URL", () => {
    expect(tlsEndpointFor("API", { url: "not a url" })).toBeNull();
    expect(tlsEndpointFor("API", {})).toBeNull();
  });
});
