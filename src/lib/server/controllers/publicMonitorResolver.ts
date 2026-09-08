import db from "../db/db.js";
import type { MonitorRecord } from "../types/db.js";

/**
 * Resolves the monitor name in a public URL to the physical tag (I3e).
 *
 * Two names exist for a monitor and the split is deliberate. `tag` is the
 * physical key: globally unique, a foreign key target five times over, half of
 * `monitoring_data`'s primary key, the Redis cache key and the BullMQ job id.
 * `slug` is the name a tenant chose, unique only within their org. A second org
 * that wants a monitor called `api` gets `slug = "api"` and `tag = "beta_api"`.
 *
 * **A public URL carries the slug**, so a tenant's visitors never see another
 * tenant's prefix. Everything below the routing layer keeps using the tag, which
 * is why this returns one.
 *
 * **For the default org this is a no-op**, because its `tag_prefix` is empty and
 * the migration backfilled `slug = tag`. That is the entire reason the slug
 * design was chosen over making `tag` per-org: every existing badge URL, embed
 * snippet, RSS link and bookmark keeps resolving to exactly the same monitor.
 *
 * **Slug first, then tag**, which is a deliberate fallback rather than
 * indecision:
 *
 *   - Slug first, because it is the public name and the one a second org's URLs
 *     will carry. Trying the tag first would let one org address another org's
 *     monitor by its prefixed tag if the tag ever escaped, and would mean the
 *     lookup order depended on which org happened to be asking.
 *   - Tag second, because tags do escape: they are what the admin screen shows,
 *     what appears in logs, and what an operator pastes into a browser when
 *     something is wrong. Answering 404 for a name the product itself displays is
 *     worse than answering the right monitor.
 *
 * Both lookups are org-scoped by `BaseRepository`, so the fallback cannot reach
 * another tenant: a tag belonging to a different org simply is not found.
 */
export async function ResolvePublicMonitor(nameInUrl: string): Promise<MonitorRecord | undefined> {
  if (!nameInUrl) return undefined;

  const bySlug = await db.getMonitorBySlug(nameInUrl);
  if (bySlug) return bySlug;

  return await db.getMonitorByTag(nameInUrl);
}

/**
 * The physical tag for a name in a public URL, or null when nothing matches.
 *
 * The form most call sites want: they already work in tags and only need the
 * URL segment translated at the boundary.
 */
export async function ResolvePublicMonitorTag(nameInUrl: string): Promise<string | null> {
  const monitor = await ResolvePublicMonitor(nameInUrl);
  return monitor?.tag ?? null;
}
