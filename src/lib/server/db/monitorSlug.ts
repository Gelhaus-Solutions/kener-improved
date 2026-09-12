/**
 * The two names a monitor has, and how to get from one to the other (I3e).
 *
 * `monitors.tag` is the physical key: globally unique across every org, a
 * foreign key target five times over, half of `monitoring_data`'s primary key,
 * the Redis cache key and the BullMQ job id. `monitors.slug` is the name a
 * tenant chose, unique only within their org, and **the name a public URL
 * carries** so that one tenant's visitors never see another tenant's prefix.
 *
 * The invariant tying them together is `tag = <prefix>_<slug>`, where the prefix
 * is the org's `tag_prefix`. The default org's prefix is empty, so its tags are
 * exactly its slugs and every URL, badge, embed and bookmark that existed before
 * tenancy still resolves byte-identically.
 *
 * **This module exists because the invariant was written down four times and
 * implemented in only two of them.** `provisionOrgMonitors` and
 * `provisionOrgPages` build the tag from the prefix correctly; the insert path
 * and both slug backfills defaulted `slug` to the *whole* tag, prefix included.
 * On the default org that is indistinguishable from correct, which is why it
 * survived: the bug is invisible until a second org exists, and then every one
 * of its public URLs carries the prefix.
 */

/**
 * The public slug for a physical tag.
 *
 * Strips the org's prefix when the tag actually carries it, and is a no-op
 * otherwise. **Both halves of that matter.** An org with no prefix must come
 * back unchanged, or every existing install rewrites all of its URLs on upgrade.
 * A tag that does not start with the prefix must also come back unchanged rather
 * than being cut blindly, because a monitor can be created with any tag through
 * the v4 API - the prefix is a convention the product applies, not something the
 * column enforces.
 */
export function slugFromTag(tag: string, tagPrefix: string | null | undefined): string {
  const prefix = tagPrefix ?? "";
  if (!prefix) return tag;

  const marker = `${prefix}_`;
  if (!tag.startsWith(marker)) return tag;

  const slug = tag.slice(marker.length);
  // A tag that is nothing but the prefix would strip to an empty slug, which
  // cannot be a URL segment and would collide with every other such monitor
  // under `monitors_org_id_slug_unique`. Keeping the tag is wrong but usable;
  // an empty slug is neither.
  return slug === "" ? tag : slug;
}

/**
 * The physical tag for a public slug.
 *
 * The inverse of `slugFromTag`, and the direction `provisionOrgMonitors` has
 * always used. Kept next to it so the two cannot drift apart.
 */
export function tagFromSlug(slug: string, tagPrefix: string | null | undefined): string {
  const prefix = tagPrefix ?? "";
  return prefix ? `${prefix}_${slug}` : slug;
}
