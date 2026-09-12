import { GetRequiredSecrets, ReplaceAllOccurrences } from "../tool.js";

/**
 * Resolves `$SECRET` tokens in a monitor's `type_data` before it leaves the
 * server (B1c).
 *
 * **Why this has to happen here and not on the probe.** Every service class
 * resolves its own secrets out of `process.env` - `apiCall` does it in its
 * constructor. Run unchanged inside the probe container, they would resolve
 * against the *probe's* environment, which does not hold Kener's secrets. A
 * monitor whose URL contains `$API_TOKEN` would then be checked with the literal
 * string `$API_TOKEN` in it and report DOWN, for a reason nothing in the result
 * would explain.
 *
 * **The trade this makes, stated plainly** (it is called out in B1c and is not
 * hidden here): the probe never holds Kener's environment, but it does see the
 * resolved credentials for the monitors assigned to it. Per-monitor secret
 * scoping is the later mitigation. Sending unresolved tokens instead would not
 * be safer, it would simply not work.
 *
 * A token with no matching environment variable is left exactly as it is, which
 * is what `GetRequiredSecrets` already does for local checks: an unset secret is
 * an operator's configuration mistake, and substituting an empty string for it
 * would turn a visible failure into a request to a subtly wrong URL.
 */

/**
 * Walks a parsed `type_data` and substitutes into every string it contains.
 *
 * Field by field rather than over a serialised blob, for the reason
 * `ApplySecretsToHeaders` gives: a secret value holding a quote or a backslash
 * would corrupt the JSON, and the whole object - often including the auth
 * header - would be dropped when it was parsed back.
 */
export function resolveTypeDataSecrets(typeData: unknown): unknown {
  // One scan of the whole structure to find which variables are needed, so
  // `process.env` is enumerated once rather than once per string.
  const secrets = GetRequiredSecrets(collectStrings(typeData).join(" "))
    .filter((secret): secret is { find: string; replace: string } => secret.replace !== undefined)
    // **Longest name first, and this is not cosmetic.** Substitution is a series
    // of plain string replacements, so with `$API` and `$API_KEY` both set,
    // doing `$API` first rewrites the *inside* of `$API_KEY` and leaves
    // `<api>_KEY` behind - a corrupted credential, silently, in whichever order
    // `process.env` happened to enumerate. Sorting by descending length means a
    // longer name is always consumed before any name that is a prefix of it.
    .sort((a, b) => b.find.length - a.find.length);
  if (secrets.length === 0) return typeData;

  const substitute = (value: string): string => {
    let out = value;
    for (const secret of secrets) {
      out = ReplaceAllOccurrences(out, secret.find, secret.replace);
    }
    return out;
  };

  return mapStrings(typeData, substitute);
}

function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
  return into;
}

function mapStrings(value: unknown, fn: (input: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    // Keys are substituted as well as values: a header's *name* can carry a
    // token, and `ApplySecretsToHeaders` already treats both sides that way.
    for (const [key, item] of Object.entries(value)) {
      out[fn(key)] = mapStrings(item, fn);
    }
    return out;
  }
  return value;
}
