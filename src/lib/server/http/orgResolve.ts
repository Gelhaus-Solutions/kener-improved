import type { Handle } from "@sveltejs/kit";
import db from "$lib/server/db/db";
import { runWithOrg, runAcrossOrgs, DEFAULT_ORG_ID } from "$lib/server/db/orgContext";
import { AuthenticateAPIKey } from "$lib/server/controllers/apiController";
import { orgPrefixOf, orgSlugOf } from "$lib/orgPath";

/**
 * Establishes the organisation for the whole of a request (I3d).
 *
 * **Why this is nearly free:** SvelteKit's `resolve(event)` awaits the entire
 * load / action / endpoint chain, so wrapping it in `runWithOrg` means every
 * `+layout.server.ts`, `+page.server.ts`, `+server.ts` and every repository call
 * underneath inherits the context with no plumbing at all. That is the whole
 * reason the org is ambient rather than an argument.
 *
 * **Resolution order, and the invariant that matters:**
 *
 *   1. A hostname in `org_domains`. For public traffic the host *is* the tenant
 *      discriminator, and P9 will make this the normal case.
 *   2. An `/o/<slug>/` prefix, for self-hosted convenience where one hostname
 *      serves several orgs. I3e decides whether this stays.
 *   3. The default org. Every single-tenant install lands here, which is what
 *      makes this whole change invisible to them.
 *
 * **The API key wins over the host, and that ordering is security-critical.**
 * For public traffic the hostname discriminates the tenant; for API traffic the
 * key does. Inverting that precedence would let a request to one tenant's
 * hostname read another tenant's data with a valid key, so the key is checked
 * first and nothing below can override it.
 *
 * The key is looked up here rather than in `apiAuthHandle`, which costs one
 * extra indexed lookup per API request and buys two things worth more than it:
 * `apiAuthHandle` then runs *entirely* inside the right org - including the
 * `locals.monitor|incident|maintenance|page` pre-resolution it does by path
 * regex, which would otherwise be a cross-tenant existence oracle - and
 * upstream's `hooks.server.ts` keeps a one-line diff instead of being
 * restructured around a closure.
 *
 * Admin routes are a third case again: the org comes from the session, not the
 * host. `sessionOrgHandle` re-enters for `/manage` page loads and `requireOrg`
 * in the action pipeline re-enters for `/manage/api`. Nested `runWithOrg` is
 * fine; the inner one wins.
 *
 * Lives in `$lib/server/http/` so the fork's footprint in upstream's
 * `hooks.server.ts` stays one import plus one name in `sequence(...)`.
 */

const BASE = (process.env.KENER_BASE_PATH || "").replace(/\/+$/, "");

/**
 * Hostname to org id.
 *
 * Cached because it is read on every public request and changes only when an
 * operator adds a domain. Sixty seconds is short enough that adding a domain
 * feels immediate and long enough that a status page under load is not issuing a
 * lookup per request. Invalidated explicitly when `org_domains` is written.
 */
const HOST_TTL_MS = 60_000;
let hostCache: { at: number; byHost: Map<string, number> } | null = null;

export function invalidateOrgDomainCache(): void {
  hostCache = null;
}

async function orgForHost(host: string): Promise<number | null> {
  const now = Date.now();
  if (!hostCache || now - hostCache.at > HOST_TTL_MS) {
    // `org_domains` is how the org is *found*, so it cannot itself be scoped by
    // one. That is the definition of a system read.
    const rows = await runAcrossOrgs(() => db.getActiveOrgDomains());
    hostCache = {
      at: now,
      byHost: new Map(rows.map((r) => [r.hostname.toLowerCase(), r.org_id])),
    };
  }
  return hostCache.byHost.get(host.toLowerCase()) ?? null;
}

export const orgResolveHandle: Handle = async ({ event, resolve }) => {
  let pathname = event.url.pathname;
  if (BASE && pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || "/";

  let orgId: number | null = null;

  // 1. The API key's org, which beats everything else.
  const authHeader = event.request.headers.get("authorization");
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      const principal = await AuthenticateAPIKey(parts[1]);
      // A key with no org predates tenancy and belongs to the default org.
      if (principal) orgId = principal.orgId ?? DEFAULT_ORG_ID;
    }
  }

  const host = orgId === null ? event.request.headers.get("host") : null;
  if (host) {
    // Port stripped: a host header is `example.com:3000` behind a proxy that
    // does not rewrite it, and the stored domain never carries a port.
    orgId = await orgForHost(host.replace(/:\d+$/, ""));
  }

  // 3. An `/o/<slug>/` prefix. `reroute` has already stripped it for routing;
  //    this reads the untouched URL, which is what `event.url` still is.
  const slug = orgSlugOf(pathname);
  let pathPrefix = "";
  if (slug) {
    const org = await runAcrossOrgs(() => db.getOrgBySlug(slug));
    // The prefix is kept even when the slug matches nothing, so a typo shows the
    // default org's content under the URL that was asked for rather than
    // silently rewriting every link on the page to drop the prefix.
    pathPrefix = orgPrefixOf(pathname);
    if (orgId === null && org && org.status === "ACTIVE") orgId = org.id;
  }

  return runWithOrg(orgId ?? DEFAULT_ORG_ID, async () => await resolve(event), pathPrefix);
};
