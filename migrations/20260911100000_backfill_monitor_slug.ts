import type { Knex } from "knex";

// The monitor slug backfill, made part of the deploy instead of a manual step.
//
// `20260909110000_add_org_schema_phase2` already runs this exact update, and the
// insert path in `repositories/monitors.ts` has defaulted `slug` to `tag` since
// I3e. Both of those close the hole going forward; neither helps an instance
// that created monitors through the admin in the window between phase 1 adding
// the nullable column and that default landing. Those rows still carry a NULL
// slug, and the public page hands the browser the *slug*, so each one is a
// monitor page that resolves to nothing.
//
// This has been carried as "run this SELECT against production, and if it
// returns anything run this UPDATE" since P12 and has not been run once. A
// manual step nobody performs is not a fix, so it becomes a migration.
//
// Re-runnable by construction: `whereNull` matches nothing on the second pass,
// and every step is guarded on the schema actually being there rather than
// wrapped in try/catch - on Postgres a failed statement aborts the surrounding
// transaction, so a catch block cannot rescue the statements after it.
//
// `tag` is the right source. It is the immutable physical key every monitor has
// carried since before tenancy, it is what `slug` was seeded from everywhere
// else, and it is unique within an org, so the composite
// `monitors_org_id_slug_unique` cannot be violated by filling one in from it.

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("monitors"))) return;
  if (!(await knex.schema.hasColumn("monitors", "slug"))) return;
  if (!(await knex.schema.hasColumn("monitors", "tag"))) return;

  await knex("monitors")
    .whereNull("slug")
    .update({ slug: knex.ref("tag") });
}

// Deliberately a no-op.
//
// Reversing this would mean setting slugs back to NULL, and there is no way to
// tell a slug this migration wrote from one an operator has since chosen. A
// down() that blanks both would destroy real configuration to undo a repair.
export async function down(): Promise<void> {}
