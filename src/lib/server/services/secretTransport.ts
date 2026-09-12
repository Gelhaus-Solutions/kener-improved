/**
 * I6. Refusing to send a credential over a channel that cannot protect it.
 *
 * **The defect this exists for, measured against a real listener.** A monitor
 * whose headers, URL, body or proxy reference a `$SECRET` had its values
 * substituted and then sent wherever the URL pointed, with no check on the
 * scheme. Three shapes were confirmed to put the resolved value on the wire in
 * clear text:
 *
 *   1. `Authorization: Bearer $TOKEN` to an `http://` URL.
 *   2. `http://host/?token=$TOKEN`, where the secret is in the query string and
 *      therefore also in every proxy and server access log on the way.
 *   3. **A config that looks safe**: an `https://` URL that answers with a 302 to
 *      `http://`, which axios follows by default, carrying the header down with
 *      it. This is the one worth the most care, because nothing in the monitor's
 *      configuration looks wrong.
 *
 * `error_message` was checked too and is a clean negative: axios reports
 * `ECONNREFUSED 127.0.0.1:9` and `getaddrinfo ENOTFOUND`, neither of which
 * carries the substituted value, so the stored and publicly rendered error text
 * does not leak. Recorded here so nobody re-derives it.
 *
 * **This file is pure and decides nothing about transport itself.** It answers
 * "would this send a secret in clear text", and the callers turn that into a
 * failed check. Pure because it is the rule that decides whether a credential
 * leaves the process, and that is worth being able to exhaust with unit tests
 * rather than infer from a live run.
 */

/** The per-monitor opt-out, in `type_data` beside `allowSelfSignedCert`. */
export interface PlaintextSecretConfig {
  allowPlaintextSecrets?: boolean;
}

/**
 * One `$NAME` and what it resolved to, as `GetRequiredSecrets` returns it.
 *
 * `find` is carried so a caller can pass that list straight through; nothing
 * here reads it, because the question is only whether a value exists.
 */
export interface SecretBinding {
  find?: string;
  replace?: string | undefined;
}

/**
 * Whether a resolved secret list actually carries a value.
 *
 * `GetRequiredSecrets` returns an entry for every `$NAME` the config mentions,
 * with `replace` undefined when no such environment variable exists. An
 * unresolved reference is sent literally as `$NAME`, which is not a secret and
 * must not fail a check: refusing on the mere *mention* of `$TOKEN` would break
 * monitors whose placeholder was never populated and which have been sending a
 * harmless literal string for months.
 */
export function carriesResolvedSecret(secrets: ReadonlyArray<SecretBinding>): boolean {
  return secrets.some((secret) => typeof secret.replace === "string" && secret.replace.length > 0);
}

/**
 * Whether a URL's scheme protects what is sent over it.
 *
 * Only `https:` and `wss:` do. Everything else - `http:`, `ws:`, and anything
 * unparseable - is treated as plaintext, which is the safe direction to be wrong
 * in: a URL this cannot parse is one whose scheme it cannot vouch for.
 *
 * **Loopback and private addresses are not special-cased, deliberately.** A
 * rule that has to decide whether `10.0.0.5` is on a network the operator
 * controls is a rule with an argument in it, and the answer differs per
 * deployment. One flag the operator sets means the same thing everywhere:
 * "I know where this goes and I accept it."
 */
export function isEncryptedUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const scheme = new URL(url).protocol;
    return scheme === "https:" || scheme === "wss:";
  } catch {
    return false;
  }
}

/** The message a refused check reports. One wording, so every surface agrees. */
export function plaintextSecretError(what: string): string {
  return (
    `Refusing to send a secret over ${what} in clear text. ` +
    `Use an encrypted URL, or tick "Allow secrets over plaintext" on this monitor if the endpoint is genuinely internal.`
  );
}

export interface TransportCheck {
  /** The resolved URL the request will actually go to. */
  url: string | undefined | null;
  /** The secret list for this monitor, from `GetRequiredSecrets`. */
  secrets: ReadonlyArray<SecretBinding>;
  /** The monitor's `type_data`, read for the opt-out. */
  typeData: PlaintextSecretConfig | null | undefined;
}

/**
 * The error text for a check that must not run, or null when it may.
 *
 * Returns a string rather than throwing because every caller turns this into a
 * recorded `MonitoringResult`: a monitor that refuses to run still has to write
 * a row for the minute, or the timeline gains a hole that reads as "nothing was
 * checked" rather than "this was deliberately refused".
 */
export function plaintextSecretRefusal({ url, secrets, typeData }: TransportCheck): string | null {
  if (typeData?.allowPlaintextSecrets === true) return null;
  if (!carriesResolvedSecret(secrets)) return null;
  if (isEncryptedUrl(url)) return null;
  return plaintextSecretError("this URL");
}

/**
 * Whether a redirect may be followed.
 *
 * The downgrade case: the configured URL is `https://` so the check above
 * passes, and the server answers 302 to `http://`. Without this the credential
 * goes out on the second request and the monitor's configuration looks correct
 * the whole time.
 *
 * Allowing a redirect *up* from http to https is deliberate: if the first hop
 * already refused, this is never reached, and a plaintext monitor with no
 * secrets has nothing to protect.
 */
export function redirectWouldLeak(location: string, { secrets, typeData }: Omit<TransportCheck, "url">): boolean {
  if (typeData?.allowPlaintextSecrets === true) return false;
  if (!carriesResolvedSecret(secrets)) return false;
  return !isEncryptedUrl(location);
}
