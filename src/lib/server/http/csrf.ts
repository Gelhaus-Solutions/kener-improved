import { normalizeHostname } from "./hostname.js";

/**
 * The cross-site form POST rule, as a decision with no request plumbing (G4).
 *
 * Split out of `hooks.server.ts` so it can be tested directly. The handler there
 * is the only origin check the app runs - `svelte.config.js` sets
 * `csrf.trustedOrigins: ["*"]`, which SvelteKit expands at build time into
 * "do not check" - so this being right is load-bearing, and a security rule that
 * can only be exercised by booting the whole hooks module, with its database and
 * proxy imports, is a rule nobody writes tests for.
 */

/**
 * Content types a browser can produce from a plain `<form>`, which are exactly
 * the ones CSRF has to cover.
 *
 * **Mirrors SvelteKit's own list deliberately, including the fourth entry.**
 * `application/x-sveltekit-formdata` is SvelteKit's binary form encoding; it was
 * missing from the fork's copy, which was harmless only while the framework's
 * check was also running. It is not harmless now.
 *
 * A JSON request is absent on purpose and is not an oversight: a form cannot
 * produce `application/json`, so a cross-site POST cannot forge one without CORS
 * preflight, which the browser will not grant.
 */
export const FORM_CONTENT_TYPES: ReadonlyArray<string> = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
  "application/x-sveltekit-formdata",
];

/** The methods a cross-site form can be submitted with. */
const PROTECTED_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isFormContentType(contentType: string | null | undefined): boolean {
  const type = (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  return FORM_CONTENT_TYPES.includes(type);
}

export interface CsrfRequestFacts {
  method: string;
  /** The `Content-Type` header, verbatim. */
  contentType: string | null;
  /** The `Origin` header, verbatim. Absent or `"null"` both count as absent. */
  origin: string | null;
  /**
   * The host the request actually arrived on - the `Host` header, falling back
   * to the URL's host only when there is none.
   *
   * **Not `url.origin`.** Under `adapter-node` that is pinned by the `ORIGIN`
   * environment variable to a single hostname for the whole process, so on a
   * tenant's custom domain it names a different host than the one the browser
   * used, and every form POST was refused as cross-site.
   */
  host: string | null;
}

/**
 * Whether this request must be refused as a cross-site form submission.
 *
 * Refuses when the `Origin` is missing, opaque, or names a different host than
 * the request arrived on. **Missing is refused, not allowed**: SvelteKit refused
 * it, so allowing it here while turning SvelteKit's check off would be a real
 * loosening rather than preserving what the app already did.
 *
 * The comparison is by hostname with the port dropped from both sides, because a
 * proxy terminating TLS commonly forwards `Host: example.com:3000` while the
 * browser's `Origin` carries no port. `orgResolveHandle` strips the port for the
 * same reason, so the two agree about what a host is.
 */
export function isForbiddenCrossSiteForm(facts: CsrfRequestFacts): boolean {
  if (!PROTECTED_METHODS.has(facts.method.toUpperCase())) return false;
  if (!isFormContentType(facts.contentType)) return false;

  const expected = normalizeHostname(facts.host ?? "");
  // The opaque origin a sandboxed iframe or a redirected cross-site form sends.
  // `normalizeHostname` would reject it anyway as an illegal hostname; naming it
  // here keeps that from resting on a parser detail.
  const origin = facts.origin && facts.origin !== "null" ? normalizeHostname(facts.origin) : null;

  if (!origin || !expected) return true;
  return origin !== expected;
}
