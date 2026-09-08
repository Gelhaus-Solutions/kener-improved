import type { Reroute } from "@sveltejs/kit";
import { base } from "$app/paths";
import { stripOrgPrefix } from "$lib/orgPath";

// Back-compat for issue #759: heartbeat URLs used to be `/ext/heartbeat/<tag>:<secret>`,
// one path segment joined by a colon. A `:` is illegal in Windows file paths, so the
// route is now `/ext/heartbeat/<tag>/<secret>` (two segments). Legacy colon-form URLs
// live forever in external cron jobs / uptime pingers, so rewrite them internally to
// the new path. Returns a 200 (no redirect) — heartbeat clients often don't follow 3xx.
//
// `reroute` is a *universal* hook: it MUST be in src/hooks.ts. A `reroute` exported from
// src/hooks.server.ts is silently ignored by SvelteKit. Keep this file free of
// server-only imports — it is bundled for the client too. Must stay pure/side-effect-free.
//
// The transform is in-place (no path reconstruction), so any KENER_BASE_PATH prefix is
// preserved automatically. `[^/:]+` matches the validated tag charset; only the first
// colon after `/ext/heartbeat/<tag>` is rewritten.
const LEGACY_HEARTBEAT = /(\/ext\/heartbeat\/[^/:]+):/;

// I3e: the optional `/o/<slug>/` organisation prefix.
//
// One instance on one hostname can serve several organisations by putting the
// org's slug in the path. The prefix is stripped here so that **every existing
// route matches underneath it** - no route files move, no `[[org]]` parameter
// spreads through the tree.
//
// The org itself is resolved server-side in `orgResolve.ts`, which reads the
// *unmodified* URL: `reroute` changes which route matches, not `event.url`. A
// slug matching no org falls through to the default org and the stripped path
// still routes, so a typo is an ordinary page rather than a 404.
//
// **Links carry the prefix because `orgPath.ts` puts it back**, not because
// relative paths happen to survive. They do not: SvelteKit computes a relative
// link from the depth of the *real* URL while aiming at the *rerouted* target,
// so on `/o/beta/monitors/kener` the home link came out as `../../../` and
// escaped to the default org. `paths.relative` is therefore off and both URL
// resolvers prepend the prefix explicitly.
//
// The shape of the prefix lives in `$lib/orgPath` so that this file, the client
// resolver and the server resolver cannot disagree about it.

export const reroute: Reroute = ({ url }) => {
  let pathname = url.pathname;

  if (LEGACY_HEARTBEAT.test(pathname)) {
    pathname = pathname.replace(LEGACY_HEARTBEAT, "$1/");
  }
  // Stripped from the base-relative part, so a KENER_BASE_PATH mount is
  // preserved exactly as the heartbeat rewrite above preserves it.
  const rest = pathname.slice(base.length);
  const stripped = stripOrgPrefix(rest);
  if (stripped !== rest) pathname = base + stripped;

  // Returning undefined when nothing changed leaves SvelteKit's own handling
  // alone, which is cheaper than handing back an identical string.
  return pathname === url.pathname ? undefined : pathname;
};
