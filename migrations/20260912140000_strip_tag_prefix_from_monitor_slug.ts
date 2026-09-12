import type { Knex } from "knex";

// Takes the org's tag prefix back off `monitors.slug`.
//
// `monitors.tag` is globally unique and carries the org's `tag_prefix`;
// `monitors.slug` is the per-org name and **is what a public URL shows**. The
// invariant is `tag = <prefix>_<slug>`, documented on `MonitorRecordInsert` and
// implemented correctly by `provisionOrgMonitors`. Two other paths defaulted the
// slug to the whole tag instead:
//
//   - `repositories/monitors.ts`, on every insert, so every monitor created
//     through the admin or the v4 API in a prefixed org
//   - the slug backfills in `20260909110000` and `20260911100000`, for rows that
//     still had a NULL slug when they ran
//
// The result is a tenant whose public URLs read `/o/postiz/monitors/postiz_earth`
// when the `/o/postiz` segment already says which org it is. Harmless to resolve,
// because `ResolvePublicMonitor` falls back from slug to tag, and wrong on every
// page, sitemap entry and RSS link that shows one.
//
// **A no-op on the default org**, whose `tag_prefix` is empty, which is the whole
// reason this went unnoticed: with one org, slug and tag are supposed to be
// identical and nothing looks wrong.
//
// The strip is duplicated here rather than imported from `db/monitorSlug.ts` on
// purpose. A migration is a historical record of what happened to a database at
// a point in time, and one that imports live application code changes its own
// behaviour whenever that code is edited.
//
// Re-runnable by construction: the second pass finds no row whose slug still
// equals its prefixed tag. Every step is guarded on the schema being there
// rather than wrapped in try/catch, because on Postgres one failed statement
// aborts the surrounding transaction and a catch block cannot rescue what
// follows it.

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("monitors"))) return;
  if (!(await knex.schema.hasTable("orgs"))) return;
  if (!(await knex.schema.hasColumn("monitors", "slug"))) return;
  if (!(await knex.schema.hasColumn("monitors", "tag"))) return;
  if (!(await knex.schema.hasColumn("orgs", "tag_prefix"))) return;

  const orgs = await knex("orgs").select("id", "tag_prefix");

  for (const org of orgs) {
    const prefix: string = org.tag_prefix ?? "";
    if (!prefix) continue;

    const marker = `${prefix}_`;

    // Only rows still carrying the default. A slug an operator has since chosen
    // no longer equals its tag, and rewriting one would change a URL somebody
    // is already linking to.
    const rows = await knex("monitors").where("org_id", org.id).whereRaw("slug = tag").select("id", "tag", "slug");

    for (const row of rows) {
      const tag = String(row.tag);
      if (!tag.startsWith(marker)) continue;

      const slug = tag.slice(marker.length);
      // A tag that is only the prefix would strip to nothing, which cannot be a
      // URL segment and would collide with every other such row under
      // `monitors_org_id_slug_unique`.
      if (slug === "") continue;

      // The unique index is per org, so a collision is possible in principle: an
      // operator could already have a monitor whose chosen slug is the stripped
      // name. Skipping leaves that row's URL with the prefix, which is what it
      // has today, rather than failing the whole migration for everybody.
      const taken = await knex("monitors").where("org_id", org.id).where("slug", slug).whereNot("id", row.id).first();
      if (taken) continue;

      await knex("monitors").where("id", row.id).update({ slug });
    }
  }
}

// Deliberately a no-op.
//
// Reversing this means putting the prefix back, and there is no way to tell a
// slug this migration stripped from one an operator chose afterwards. A down()
// that re-prefixed both would rewrite real configuration to undo a repair.
export async function down(): Promise<void> {}
