import { redirect, type Handle } from "@sveltejs/kit";
import serverResolve from "$lib/server/resolver.js";

/**
 * Permanent redirects for the admin screens I3f moved.
 *
 * Six sidebar entries became three, by nesting the smaller screens under the
 * screen they belong to and giving each parent a tab bar. The routes moved with
 * them, so every bookmark, every link in a runbook and every browser history
 * entry pointing at an old path would 404. These keep them working.
 *
 * A hook rather than six redirecting stub routes: a stub route would have to be
 * re-declared in the route permission map and would run the whole `(manage)`
 * layout load, including the MFA guard, only to throw a redirect at the end.
 * Matching here happens before route resolution, so an old path costs one string
 * comparison.
 *
 * `/manage/app/share` has no page of its own, so it lands on the first tab.
 *
 * This lives in `$lib/server/http` for the same reason `requestId.ts` does:
 * `hooks.server.ts` is upstream's file, and the fork's whole footprint there is
 * one import plus one name in the `sequence(...)` call.
 */
const MOVED: Record<string, string> = {
  "/manage/app/analytics-providers": "/manage/app/site-configurations/analytics-providers",
  "/manage/app/captcha-providers": "/manage/app/site-configurations/captcha-providers",
  "/manage/app/badges": "/manage/app/share/badges",
  "/manage/app/embed": "/manage/app/share/embed",
  "/manage/app/share": "/manage/app/share/badges",
  "/manage/app/deliveries": "/manage/app/webhooks/deliveries",
  "/manage/app/event-consumers": "/manage/app/webhooks/event-consumers",
};

// `event.url.pathname` still carries KENER_BASE_PATH, while the table above is
// written in route terms. Strip the base before matching, and let
// `serverResolve` put it back on the way out.
const BASE = (process.env.KENER_BASE_PATH || "").replace(/\/+$/, "");

export const manageRedirectHandle: Handle = async ({ event, resolve }) => {
  let pathname = event.url.pathname;
  if (BASE && pathname.startsWith(BASE)) {
    pathname = pathname.slice(BASE.length) || "/";
  }
  // Tolerate a trailing slash: SvelteKit would normalise it away, but this runs
  // first.
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");

  const target = MOVED[pathname];
  if (target) {
    throw redirect(308, serverResolve(target) + event.url.search);
  }

  return resolve(event);
};
