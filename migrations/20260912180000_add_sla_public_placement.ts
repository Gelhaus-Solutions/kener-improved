import type { Knex } from "knex";

// Where a published SLO target actually appears, and how much of it is shown.
//
// **The bug this fixes.** `show_on_public` was a single boolean offered for all
// three scope types, but the only public reader in the whole application was the
// component page, and it filters `scope_type = 'MONITOR'`. So a PAGE- or
// CATEGORY-scoped target could be marked public, show a "Public" badge in the
// admin list, be evaluated on schedule - and render nowhere at all, forever,
// with nothing to indicate why. A boolean cannot say "where", and there was only
// ever one "where" built.
//
// **`public_placements` is now the source of truth for visibility.** A JSON
// array of surface tokens; empty or null means not published. Which surfaces are
// legal depends on the scope, and that rule lives in `services/slo.ts` rather
// than here - a CHECK constraint would have to be written twice per dialect and
// would freeze a vocabulary that is expected to grow.
//
// **`show_on_public` is kept and demoted to a derived mirror.** Dropping it
// would be a table rebuild on SQLite, which is the cascade hazard this schema
// has been bitten by before, for no gain: nothing reads it after this migration,
// `saveSlaTarget` keeps it in step as `YES` exactly when placements is non-empty,
// and anything outside this repo still reading it sees the same answer it did.
//
// **The backfill is the whole point of shipping this as a migration.** Every
// target an operator already ticked gets the placement that matches its scope,
// so the page- and category-scoped ones that have silently rendered nowhere
// start appearing on deploy rather than needing to be re-saved by hand.

const TARGETS = "sla_targets";

/** Mirrors `SLO_SURFACES_BY_SCOPE` in `src/lib/server/services/slo.ts`. */
const DEFAULT_PLACEMENT: Record<string, string> = {
  MONITOR: JSON.stringify(["COMPONENT_PAGE"]),
  PAGE: JSON.stringify(["PAGE_TOP"]),
  CATEGORY: JSON.stringify(["CATEGORY_SECTION"]),
};

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TARGETS))) return;

  if (!(await knex.schema.hasColumn(TARGETS, "public_placements"))) {
    await knex.schema.alterTable(TARGETS, (table) => {
      // Nullable, and null means "not published". A default of '[]' would be
      // equivalent but would make every existing row look deliberately emptied
      // rather than never configured.
      table.text("public_placements").nullable();
    });
  }

  if (!(await knex.schema.hasColumn(TARGETS, "public_detail"))) {
    await knex.schema.alterTable(TARGETS, (table) => {
      // COMPACT | FULL. FULL is what the panel has always rendered, so an
      // existing published target keeps looking exactly as it did.
      table.string("public_detail", 16).notNullable().defaultTo("FULL");
    });
  }

  // Backfill, scope by scope. Guarded on `public_placements IS NULL` so a
  // re-run cannot overwrite a placement an operator has since chosen, which is
  // what makes this safe to leave in place.
  for (const [scopeType, placement] of Object.entries(DEFAULT_PLACEMENT)) {
    await knex(TARGETS)
      .where("scope_type", scopeType)
      .where("show_on_public", "YES")
      .whereNull("public_placements")
      .update({ public_placements: placement });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TARGETS))) return;

  // Postgres only. Dropping a column on SQLite is a table rebuild, and a rebuild
  // of `sla_targets` would take `monitor_alerts_config.sla_target_id` with it
  // wherever that foreign key exists - the same cascade that deleted 77
  // `roles_permissions` rows earlier in this schema's life. `show_on_public`
  // still carries the on/off answer, so leaving the two columns in place on
  // SQLite loses nothing.
  if (knex.client.config.client !== "pg") return;

  if (await knex.schema.hasColumn(TARGETS, "public_placements")) {
    await knex.schema.alterTable(TARGETS, (table) => table.dropColumn("public_placements"));
  }
  if (await knex.schema.hasColumn(TARGETS, "public_detail")) {
    await knex.schema.alterTable(TARGETS, (table) => table.dropColumn("public_detail"));
  }
}
