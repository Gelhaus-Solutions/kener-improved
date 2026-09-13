import tls from "tls";
import type { PeerCertificate } from "tls";

/**
 * B7. Reading a TLS certificate in order to REPORT on it.
 *
 * **Why this is not `sslCall.ts`.** That module answers "is this monitor up",
 * and it calls `tls.connect` with Node's default `rejectUnauthorized: true`. So
 * a self-signed, expired or otherwise untrusted certificate makes the connection
 * *fail*, and the monitor reports DOWN with a socket error. That is the right
 * behaviour for an SSL monitor and it is useless for an alert that has to
 * distinguish "expiring in nine days" from "issued by someone we do not trust":
 * both arrive as the same thrown error, and the interesting one arrives only
 * once it is already too late.
 *
 * So this connects with validation OFF and then asks what validation *would*
 * have said, via `socket.authorized` and `socket.authorizationError`. That is
 * the only way to hold a certificate and describe it rather than be refused it.
 *
 * **Turning validation off here is not a weakening.** Nothing is sent over this
 * socket and no data is trusted from it; the connection exists to read a public
 * certificate that any client is handed before authentication. The alternative
 * is being unable to warn about exactly the certificates most in need of a
 * warning.
 */

/** How long to wait for a handshake before calling the host unreachable. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface CertificateFacts {
  reachable: true;
  /** Whole days until `valid_to`. Negative once it has expired. */
  daysRemaining: number;
  validTo: Date;
  validFrom: Date;
  issuer: string | null;
  subject: string | null;
  /** What Node's own chain validation concluded. */
  authorized: boolean;
  /** The reason it refused, when it did. */
  authorizationError: string | null;
  /** Issuer equals subject, which is what a self-signed certificate looks like. */
  selfSigned: boolean;
  protocol: string | null;
}

export interface CertificateUnreachable {
  reachable: false;
  error: string;
}

export type CertificateInspection = CertificateFacts | CertificateUnreachable;

/**
 * `socket.authorizationError`, as a string, whatever Node actually put there.
 *
 * **Node's own types declare this as `Error`, and at runtime it is a plain
 * string** - measured against `untrusted-root.badssl.com`, where it is
 * `"SELF_SIGNED_CERT_IN_CHAIN"` with `typeof === "string"`. So reading
 * `.message` (which is what the type invites) yields `undefined` and the
 * actionable OpenSSL code is silently replaced by a generic fallback. That code
 * is the single most useful thing in the alert: it is the difference between
 * "install the intermediate" and "replace the certificate".
 *
 * Both shapes are handled because the typing says one thing and the runtime does
 * another, and a future Node could correct itself in either direction.
 */
function authorizationErrorText(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return String(value);
}

/** A distinguished-name field, flattened to something readable in a message. */
function nameOf(dn: PeerCertificate["issuer"] | undefined): string | null {
  if (!dn || typeof dn !== "object") return null;
  const record = dn as unknown as Record<string, string>;
  return record.CN ?? record.O ?? null;
}

/**
 * Whole days from `now` until `validTo`.
 *
 * Truncated toward zero rather than rounded, so a certificate with 29.9 days
 * left reports 29. A threshold of "warn at 30" should fire on that one: rounding
 * up would hold the warning back for most of a day at exactly the moment the
 * operator asked to hear about it.
 */
export function daysUntil(validTo: Date, now: Date): number {
  return Math.floor((validTo.getTime() - now.getTime()) / 86_400_000);
}

/**
 * Opens a TLS connection and describes the certificate it is offered.
 *
 * Never throws and never rejects: an unreachable host is a legitimate answer
 * that the caller has to handle differently from a bad certificate, so it comes
 * back as data rather than as an exception.
 */
export function inspectCertificate(
  host: string,
  port = 443,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  now: Date = new Date(),
): Promise<CertificateInspection> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CertificateInspection) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Already gone; nothing to clean up.
      }
      resolve(result);
    };

    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        // The whole point. See the module comment.
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      () => {
        // `true` gives the full chain, which is what makes a missing
        // intermediate distinguishable from a bad leaf.
        const cert = socket.getPeerCertificate(true);

        if (!cert || !cert.valid_to) {
          finish({ reachable: false, error: "The host offered no certificate" });
          return;
        }

        const validTo = new Date(cert.valid_to);
        const validFrom = new Date(cert.valid_from);
        if (Number.isNaN(validTo.getTime())) {
          finish({ reachable: false, error: `Unreadable certificate validity: ${cert.valid_to}` });
          return;
        }

        const issuer = nameOf(cert.issuer);
        const subject = nameOf(cert.subject);

        finish({
          reachable: true,
          daysRemaining: daysUntil(validTo, now),
          validTo,
          validFrom,
          issuer,
          subject,
          authorized: socket.authorized,
          authorizationError: socket.authorized
            ? null
            : (authorizationErrorText(socket.authorizationError) ?? "unauthorized"),
          // Compared on the distinguished names rather than on the error code,
          // because a self-signed certificate and one from an unknown authority
          // both report DEPTH_ZERO_SELF_SIGNED_CERT or UNABLE_TO_VERIFY on
          // different Node versions, and the operator's next action differs.
          selfSigned: issuer !== null && subject !== null && issuer === subject,
          protocol: socket.getProtocol(),
        });
      },
    );

    socket.on("timeout", () => finish({ reachable: false, error: `No handshake within ${timeoutMs}ms` }));
    socket.on("error", (error: Error) => finish({ reachable: false, error: error.message }));
  });
}
