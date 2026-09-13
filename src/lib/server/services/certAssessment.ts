import type { CertificateInspection } from "./certificateInspector.js";

/**
 * B7. Turning certificate facts into an alert verdict.
 *
 * Pure, and separated from `certificateInspector` deliberately: the rules below
 * are the part that decides whether somebody is woken up, and they should be
 * testable without opening a socket.
 */

export type CertVerdict = "OK" | "EXPIRING" | "EXPIRED" | "UNTRUSTED" | "UNREACHABLE";

export interface CertAssessment {
  verdict: CertVerdict;
  /** A sentence for the alert body. Always set, including for OK. */
  detail: string;
  /** Null when the certificate could not be read. */
  daysRemaining: number | null;
}

/**
 * Assesses a certificate against a threshold in days.
 *
 * **Order matters and expiry is tested BEFORE trust.** An expired certificate
 * also fails chain validation, so asking about trust first would report every
 * expired certificate as untrusted and send the operator hunting for a missing
 * intermediate that is not missing. The expiry is the actionable fact; the
 * validation failure is its consequence.
 *
 * **UNREACHABLE is neither firing nor recovering**, and that is the rule that
 * keeps this honest. "We could not read the certificate" is not "the
 * certificate is fine", and it is not "the certificate is bad" either. Treating
 * it as recovery would close every certificate alert the moment a host went
 * down, which is exactly when nobody is looking at certificates. Treating it as
 * firing would page the on-call about TLS during an ordinary outage. The caller
 * maps it to "no change" in both directions; this only has to name it.
 */
export function assessCertificate(inspection: CertificateInspection, thresholdDays: number): CertAssessment {
  if (!inspection.reachable) {
    return {
      verdict: "UNREACHABLE",
      detail: `Could not read the certificate: ${inspection.error}`,
      daysRemaining: null,
    };
  }

  const { daysRemaining, validTo, issuer, authorized, authorizationError, selfSigned } = inspection;
  const expiresOn = validTo.toISOString().slice(0, 10);

  if (daysRemaining < 0) {
    return {
      verdict: "EXPIRED",
      detail: `The certificate expired on ${expiresOn}, ${Math.abs(daysRemaining)} day(s) ago.`,
      daysRemaining,
    };
  }

  if (daysRemaining <= thresholdDays) {
    return {
      verdict: "EXPIRING",
      detail:
        daysRemaining === 0
          ? `The certificate expires today, ${expiresOn}.`
          : `The certificate expires in ${daysRemaining} day(s), on ${expiresOn}.`,
      daysRemaining,
    };
  }

  // Only once expiry is ruled out, so this always means a real trust problem
  // rather than the side effect of an expired leaf.
  if (!authorized) {
    return {
      verdict: "UNTRUSTED",
      detail: selfSigned
        ? `The certificate is self-signed (issuer ${issuer ?? "unknown"}), so no client will trust it.`
        : `The certificate chain did not validate: ${authorizationError ?? "unknown reason"}.`,
      daysRemaining,
    };
  }

  return {
    verdict: "OK",
    detail: `Valid until ${expiresOn}, ${daysRemaining} day(s) away.`,
    daysRemaining,
  };
}

/**
 * Whether a verdict should open or sustain an alert.
 *
 * `null` means "cannot tell", which the alerting queue already understands as
 * "do nothing" - the same contract `sloBurnVerdict` uses for a target it cannot
 * judge.
 */
export function isFiring(verdict: CertVerdict): boolean | null {
  if (verdict === "UNREACHABLE") return null;
  return verdict !== "OK";
}

/**
 * Whether a verdict should resolve an open alert.
 *
 * Only an explicit OK resolves. UNREACHABLE must not, for the reason on
 * `assessCertificate`: it would close every certificate alert the moment
 * monitoring broke.
 */
export function isRecovered(verdict: CertVerdict): boolean {
  return verdict === "OK";
}

/** Where a monitor's TLS certificate can be read from, if it has one at all. */
export interface TlsEndpoint {
  host: string;
  port: number;
}

/**
 * B7. The TLS endpoint a monitor's certificate alert should inspect.
 *
 * **Derived from the monitor rather than configured separately**, because an
 * operator who has already told Kener where the service is should not have to
 * say it twice, and a second copy is a second thing to keep in step when the
 * service moves.
 *
 * Returns null for every monitor with no TLS to speak of - PING, DNS, SQL,
 * GAMEDIG, HEARTBEAT, GROUP, NONE, a plain http:// API monitor, a gRPC monitor
 * with TLS switched off. A certificate alert on one of those is a configuration
 * mistake, and the caller reports it as such rather than inventing an endpoint.
 */
export function tlsEndpointFor(monitorType: string, typeData: Record<string, unknown>): TlsEndpoint | null {
  const asString = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const asPort = (v: unknown, fallback: number): number => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? n : fallback;
  };

  if (monitorType === "SSL") {
    const host = asString(typeData.host);
    return host ? { host, port: asPort(typeData.port, 443) } : null;
  }

  if (monitorType === "API") {
    const url = asString(typeData.url);
    if (!url) return null;
    try {
      const parsed = new URL(url);
      // http:// has no certificate. Silently inspecting port 443 instead would
      // report on a service the monitor does not watch.
      if (parsed.protocol !== "https:") return null;
      return { host: parsed.hostname, port: parsed.port ? asPort(parsed.port, 443) : 443 };
    } catch {
      return null;
    }
  }

  if (monitorType === "TCP") {
    // A TCP monitor may hold several hosts; the certificate belongs to the
    // first, which is the one an operator naming a single endpoint means.
    const hosts = typeData.hosts;
    const first = Array.isArray(hosts) ? (hosts[0] as Record<string, unknown> | undefined) : undefined;
    const host = asString(first?.host) ?? asString(typeData.host);
    if (!host) return null;
    const port = asPort(first?.port ?? typeData.port, 0);
    // No default here: a TCP service's TLS port is not knowable, and guessing
    // 443 would quietly inspect a different service on the same machine.
    return port > 0 ? { host, port } : null;
  }

  if (monitorType === "GRPC") {
    if (typeData.tls !== true) return null;
    const host = asString(typeData.host);
    return host ? { host, port: asPort(typeData.port, 443) } : null;
  }

  return null;
}
