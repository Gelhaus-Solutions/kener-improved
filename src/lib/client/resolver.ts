import { base } from "$app/paths";
import { page } from "$app/state";
import { isStaticAssetPath, orgPrefixOf } from "$lib/orgPath";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ResolveFn = (...args: any[]) => string;

/**
 * Wrapper for SvelteKit's resolve function
 * @param resolve - The resolve function from $app/paths
 * @param path - The route path or route ID (e.g., "/blog/[slug]") or absolute URL
 * @param params - Optional parameters for dynamic route segments
 * @returns The resolved URL with base path, or the original URL if it's absolute
 *
 * @example
 * ```ts
 * // Using a static path
 * urlResolve(resolve, "/dashboard-apis/monitor-bar")
 *
 * // Using a dynamic route with params
 * urlResolve(resolve, "/blog/[slug]", { slug: "hello-world" })
 *
 * // Using an absolute URL (returns as-is)
 * urlResolve(resolve, "https://example.com/api")
 * ```
 */
export default function urlResolve(resolve: ResolveFn, path: string, params?: Record<string, string>): string {
  // If path is an absolute URL, return it as-is
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  const resolved = params ? resolve(path, params) : resolve(path);
  return withOrgPrefix(resolved);
}

/**
 * Keeps a link inside the `/o/<slug>/` organisation prefix the page is under (I3e).
 *
 * `paths.relative` is off, so `resolve()` returns an absolute, base-prefixed
 * path with no idea that organisations exist. Without this, every link on an
 * org-prefixed page would point at the default organisation - which is exactly
 * what happened before the prefix was made explicit.
 *
 * The prefix is read from the URL the browser is actually on rather than passed
 * in, so none of the eighty-odd call sites change. `page` is read defensively:
 * it is only guaranteed during component rendering, and a couple of client-only
 * modules call this outside one, where `location` is the same truth.
 *
 * A no-op for every install that does not use the prefix, which is all of them
 * that give a tenant its own hostname.
 */
function withOrgPrefix(resolvedPath: string): string {
  if (!resolvedPath.startsWith("/")) return resolvedPath;

  let pathname: string | undefined;
  try {
    pathname = page.url?.pathname;
  } catch {
    // Not during component rendering.
  }
  if (!pathname && typeof location !== "undefined") pathname = location.pathname;
  if (!pathname) return resolvedPath;

  const prefix = orgPrefixOf(pathname.slice(base.length));
  if (!prefix) return resolvedPath;

  // `resolve()` has already applied the base path, so the org prefix belongs
  // between the base and the route.
  const withoutBase = resolvedPath.slice(base.length);
  if (orgPrefixOf(withoutBase)) return resolvedPath;
  // A file on disk, served before the router ever sees it.
  if (isStaticAssetPath(withoutBase)) return resolvedPath;
  return `${base}${prefix}${withoutBase}`;
}

/**
 * Resolves a path to an absolute URL by prefixing the site URL.
 * Required for meta tags like og:image and twitter:image that need absolute URLs.
 * @param resolve - The resolve function from $app/paths
 * @param siteUrl - The site URL (e.g., "https://status.example.com")
 * @param path - The route path or absolute URL
 * @param params - Optional parameters for dynamic route segments
 * @returns An absolute URL, or the resolved relative URL if siteUrl is empty
 *
 * @example
 * ```ts
 * absoluteResolve(resolve, "https://status.example.com", "/uploads/preview.png")
 * // => "https://status.example.com/uploads/preview.png"
 * ```
 */
export function absoluteResolve(
  resolve: ResolveFn,
  siteUrl: string,
  path: string,
  params?: Record<string, string>,
): string {
  // Normalize relative paths like "./assets/..." to "/assets/..." so the
  // final URL doesn't contain "/./" segments (crawlers don't normalize these)
  const normalizedPath = path.startsWith("./") ? path.slice(1) : path;
  const resolved = urlResolve(resolve, normalizedPath, params);
  // Already absolute, return as-is
  if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
    return resolved;
  }
  if (!siteUrl) {
    return resolved;
  }
  const trimmedSiteUrl = siteUrl.replace(/\/+$/, "");
  return trimmedSiteUrl + (resolved.startsWith("/") ? resolved : "/" + resolved);
}
