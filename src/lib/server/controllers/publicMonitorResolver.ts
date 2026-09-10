import db from "../db/db.js";
import GC from "../../global-constants.js";
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

/**
 * Is this monitor one an anonymous visitor is allowed to see at all?
 *
 * **One definition, because the codebase had nine and only some of them agreed.**
 * The page route, the four badge types and the RSS feed each apply "ACTIVE and
 * not hidden" in their own words; every `dashboard-apis` endpoint and both embed
 * routes applied nothing, and served a hidden monitor's name, description, image
 * and ninety days of history to anyone who knew its tag (KENER-126).
 *
 * Hiding a monitor in v4 means it is not publicly reachable, not merely
 * unlisted: `(kener)/monitors/[monitor_tag]` answers 404 for one, and a badge
 * renders an error. (v3's changelog described hidden *categories* as still
 * reachable by direct link. That is v3, and v4's own routes settled it the other
 * way long before this function existed.)
 *
 * The test matches the query the rest of the codebase issues - `status =
 * 'ACTIVE' AND is_hidden = 'NO'` - rather than a looser one, so a monitor cannot
 * be visible through here and invisible through the page route. `is_hidden` is
 * NOT NULL DEFAULT 'NO', so there is no third state to worry about.
 */
export function isPubliclyVisible(monitor: Pick<MonitorRecord, "status" | "is_hidden">): boolean {
  return monitor.status === GC.ACTIVE && monitor.is_hidden === GC.NO;
}

/**
 * The monitor behind a public URL segment, but only if the public may see it.
 *
 * What every anonymous read surface should call. `ResolvePublicMonitor` is the
 * wrong function for those: it answers "which monitor is this name", which is
 * also what an authenticated API request and a heartbeat ingest need, and both
 * of those must keep reaching hidden monitors. Splitting the visibility check
 * into its own function is what lets those two keep working while the public
 * surfaces get the check they were missing.
 */
export async function ResolveVisiblePublicMonitor(nameInUrl: string): Promise<MonitorRecord | undefined> {
  const monitor = await ResolvePublicMonitor(nameInUrl);
  if (!monitor) return undefined;
  return isPubliclyVisible(monitor) ? monitor : undefined;
}

/**
 * The subset of these physical tags the public may see.
 *
 * For the batch endpoint, which takes up to a hundred tags at once and must not
 * turn that into a hundred round trips. Tags rather than slugs on purpose: the
 * only caller receives them from a page's own serialised data, where they are
 * already physical.
 */
export async function GetVisiblePublicMonitorsByTags(tags: string[]): Promise<MonitorRecord[]> {
  if (tags.length === 0) return [];
  return (await db.getMonitorsByTags(tags)).filter(isPubliclyVisible);
}

/**
 * Many public names at once, resolved and filtered, keyed by what was asked for.
 *
 * The batch form of `ResolveVisiblePublicMonitor`, and the key matters as much as
 * the value: the caller asked for "api" and has to be able to find "api" in the
 * answer, even though the monitor is physically `beta_api`. Returning a map keyed
 * by the physical tag would resolve the monitor correctly and still leave the
 * browser unable to match the response to the request.
 *
 * Slug before tag, the same precedence and for the same reasons as
 * `ResolvePublicMonitor`. Both queries are org-scoped, so neither can reach
 * another tenant.
 */
export async function ResolveVisiblePublicMonitors(namesInUrl: string[]): Promise<Map<string, MonitorRecord>> {
  const resolved = new Map<string, MonitorRecord>();
  if (namesInUrl.length === 0) return resolved;

  const [bySlugRows, byTagRows] = await Promise.all([
    db.getMonitorsBySlugs(namesInUrl),
    db.getMonitorsByTags(namesInUrl),
  ]);
  // A row whose `slug` is null is skipped rather than indexed under a null key:
  // the column is nullable, and `null` is not a name anybody can ask for.
  const bySlug = new Map(bySlugRows.filter((m) => !!m.slug).map((m) => [m.slug as string, m]));
  const byTag = new Map(byTagRows.map((m) => [m.tag, m]));

  for (const name of namesInUrl) {
    const monitor = bySlug.get(name) ?? byTag.get(name);
    if (monitor && isPubliclyVisible(monitor)) resolved.set(name, monitor);
  }
  return resolved;
}
