import type { Handle } from "@sveltejs/kit";
import db from "$lib/server/db/db";
import { runWithOrg, runAcrossOrgs } from "$lib/server/db/orgContext";
import { ResolveSession } from "$lib/server/controllers/sessionController";

/**
 * Admin traffic acts in the **session's** org, not the hostname's (I3f).
 *
 * `orgResolveHandle` has already established a host-derived org for the request,
 * and for public traffic that is exactly right. For the admin it is wrong: an
 * operator administering three tenants reaches all of them through one hostname,
 * so which org they are acting in is a property of their session.
 *
 * The action pipeline already knew that - `requireOrg` reads
 * `sessions.active_org_id` on every `/manage/api` call. **Page loads did not.**
 * Nothing between `orgResolveHandle` and a `+page.server.ts` ever consulted the
 * session, so every admin screen rendered the *host's* org while the API it
 * called rendered the session's. With one org those are the same number and the
 * gap is invisible; with two, an org switcher would change the data the buttons
 * write and none of the data on the screen.
 *
 * A handle rather than the `(manage)` layout load, because a layout load does
 * not enclose the sibling page load: SvelteKit runs them concurrently, so an
 * `AsyncLocalStorage` context entered in the layout would not be visible to the
 * page. `resolve(event)` encloses both, which is the same property that makes
 * `orgResolveHandle` free.
 *
 * **Scoped to `/manage`.** A signed-in operator looking at another tenant's
 * public status page must still see that tenant's page, so this deliberately
 * does not apply to public routes even though the cookie is present on them.
 *
 * `/manage/api` passes through here too and is then re-entered by `requireOrg`.
 * That is redundant rather than wrong, and the redundancy is worth keeping: the
 * pipeline's check is the one that is security-critical, and it should not
 * quietly become dependent on a hook having run first.
 *
 * Membership is checked here for the same reason `requireOrg` checks it: a
 * session can name any org id, and membership is what makes it legitimate. A
 * session pointing somewhere the user may not go simply keeps the host's org,
 * and the layout's own permission check refuses them from there - this is not
 * the place to decide how a revoked membership is reported.
 *
 * Lives in `$lib/server/http/` so the fork's footprint in upstream's
 * `hooks.server.ts` stays one import plus one name in `sequence(...)`.
 */

const BASE = (process.env.KENER_BASE_PATH || "").replace(/\/+$/, "");

function isManagePath(pathname: string): boolean {
  return pathname === "/manage" || pathname.startsWith("/manage/");
}

export const sessionOrgHandle: Handle = async ({ event, resolve }) => {
  let pathname = event.url.pathname;
  if (BASE && pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || "/";

  if (!isManagePath(pathname)) return resolve(event);

  const resolved = await ResolveSession(event.cookies);
  const orgId = resolved?.session.active_org_id ?? null;
  if (!resolved || orgId === null) return resolve(event);

  // Across orgs because `org_members` is what determines the org, so it cannot
  // be filtered by the answer it is producing.
  const isMember = await runAcrossOrgs(() => db.isOrgMember(orgId, resolved.user.id));
  if (!isMember) return resolve(event);

  return runWithOrg(orgId, async () => await resolve(event));
};
