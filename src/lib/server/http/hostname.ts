// G4. Turning what an operator pasted into what the `Host` header will contain.
//
// **This is the difference between a domain that works and one that silently
// never does.** An operator copies `https://status.acme.com/` out of a browser
// bar. Stored verbatim, it matches no `Host` header ever sent, so the domain
// resolves to nothing, the page falls through to the default org, and there is
// no error anywhere to explain it. Normalising on the way in is the only place
// that mistake can be caught.

/**
 * The `Host` form of `input`, or null if it cannot be one.
 *
 * Accepts a bare hostname, a URL, or something with a port, and returns the
 * lowercase hostname with no scheme, port, path or trailing dot.
 */
export function normalizeHostname(input: string): string | null {
  let value = (input ?? "").trim().toLowerCase();
  if (!value) return null;

  // A pasted URL. Parsed rather than string-stripped so credentials, ports and
  // paths all come off in one go and cannot be half-removed.
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  } else {
    // Bare `host:port/path` never parses as a URL, so trim the two by hand.
    value = value.split("/")[0];
    // IPv6 literals are bracketed and legitimately full of colons; only strip a
    // port from something that is not one.
    if (!value.startsWith("[")) value = value.split(":")[0];
  }

  // A fully-qualified name may end in a dot. `example.com.` and `example.com`
  // are the same host, and a stored trailing dot would never match.
  value = value.replace(/\.+$/, "");

  if (!value) return null;
  // No whitespace, no wildcards, no path separators. Deliberately permissive
  // about the rest: internationalised and single-label internal names are both
  // legitimate here, and this is an operator-only field, not user input.
  if (/[\s*?#@/\\]/.test(value)) return null;
  if (value.length > 255) return null;

  return value;
}
