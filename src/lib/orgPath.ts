/**
 * The optional `/o/<slug>/` organisation prefix (I3e).
 *
 * Pure and dependency-free on purpose: it is used by `src/hooks.ts`, which is a
 * *universal* hook bundled for the browser and required to stay side-effect
 * free, and by both URL resolvers on the server and the client. One definition
 * of what the prefix looks like, or the three of them drift and a link silently
 * escapes the organisation it belonged to.
 *
 * The prefix lets one instance on one hostname serve several organisations,
 * which is the self-hosting case. A tenant with its own hostname needs none of
 * this: `org_domains` resolves it, and the prefix never appears.
 */

/**
 * Matched only at the very start of a base-relative path.
 *
 * Anchored so a page or monitor legitimately named `o` deeper in a path cannot
 * be mistaken for a prefix, and the lookahead means `/o/beta` and `/o/betaX`
 * are different things rather than one matching inside the other.
 */
const ORG_PREFIX = /^\/o\/([A-Za-z0-9][A-Za-z0-9_-]{0,62})(?=\/|$)/;

/** The `/o/<slug>` prefix on a base-relative path, or `""` when there is none. */
export function orgPrefixOf(baseRelativePath: string): string {
  const match = baseRelativePath.match(ORG_PREFIX);
  return match ? match[0] : "";
}

/** The org slug in a base-relative path, or null. */
export function orgSlugOf(baseRelativePath: string): string | null {
  const match = baseRelativePath.match(ORG_PREFIX);
  return match ? match[1] : null;
}

/**
 * The path with any `/o/<slug>` prefix removed.
 *
 * `/o/beta` alone becomes `/` rather than the empty string, which is not a
 * routable path.
 */
export function stripOrgPrefix(baseRelativePath: string): string {
  const stripped = baseRelativePath.replace(ORG_PREFIX, "");
  if (stripped === baseRelativePath) return baseRelativePath;
  return stripped === "" ? "/" : stripped;
}

/**
 * Paths that must never carry the org prefix, because they are files rather than routes.
 *
 * Static assets are served straight off disk - by Vite in development and by the
 * Express layer in production - **before** SvelteKit's router runs, so `reroute`
 * never sees them and `/o/beta/logo96.png` is simply a file that does not exist.
 * They are also org-agnostic: one copy of `logo96.png` serves every tenant.
 *
 * The rule rather than a hand-maintained list of filenames, so that upstream
 * adding another image to `static/` does not quietly produce a 404:
 *
 *   - anything under a static directory (`uploads/`, `api-references/`);
 *   - a single-segment path carrying a file extension (`/logo96.png`,
 *     `/robots.txt`, `/og.jpg`), which is what everything in `static/`'s root
 *     looks like.
 *
 * The exceptions are the three routes that also look like files. They are routes,
 * they render per-org content, and they must carry the prefix.
 */
const STATIC_DIRECTORIES = ["uploads", "api-references"];
const ROOT_ROUTES_THAT_LOOK_LIKE_FILES = new Set(["rss.xml", "capture.js", "captcha-config.json"]);

export function isStaticAssetPath(baseRelativePath: string): boolean {
  const segments = baseRelativePath.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (STATIC_DIRECTORIES.includes(segments[0])) return true;
  if (segments.length === 1 && segments[0].includes(".")) {
    return !ROOT_ROUTES_THAT_LOOK_LIKE_FILES.has(segments[0]);
  }
  return false;
}
