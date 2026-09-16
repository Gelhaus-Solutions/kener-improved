import type { Knex } from "knex";

// B12a: which axis a region may serve.
//
// **Two axes, one catalogue, decided by Enno on 2026-09-16.** A region row is a
// PLACE. Frankfurt is Frankfurt whether a check runs FROM it (the probe region,
// which is what `monitoring_data.region_id` has always meant) or a checked
// service is deployed IN it (the target region, which B12 adds). Which of those
// a particular relationship is about is a property of the relationship, not of
// the place, so a second catalogue would be a second Frankfurt with its own
// coordinates, its own screen and its own built-in lookup, and B13 stage 2 would
// need a second path through a map that already draws regions perfectly well.
//
// The alternative considered and rejected was a bare reuse with no marker. That
// is how the two axes got conflated once already: with nothing recording which
// axes a row is for, every list of regions is a list for both, and a probe-only
// region silently becomes offerable as a deployment location.
//
// **Two booleans rather than one enum**, which is the one place this could
// plausibly have gone the other way. An enum of PROBE | TARGET | BOTH | NONE is
// four values encoding two independent bits: "neither" and "both" are real and
// equally legitimate states, every query wants one bit (`where usable_as_target`)
// rather than a three-way IN list, and a third axis later is a column rather
// than an enum migration that has to rewrite every existing value.
const REGIONS = "regions";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(REGIONS))) return;

  const addedProbe = !(await knex.schema.hasColumn(REGIONS, "usable_as_probe"));
  if (addedProbe) {
    await knex.schema.alterTable(REGIONS, (table) => {
      // Defaults chosen so that an install which upgrades and configures nothing
      // behaves exactly as it did: every region it has is a probe region, and
      // nothing is offerable as a deployment target until somebody says so.
      table.boolean("usable_as_probe").notNullable().defaultTo(true);
    });
  }

  if (!(await knex.schema.hasColumn(REGIONS, "usable_as_target"))) {
    await knex.schema.alterTable(REGIONS, (table) => {
      table.boolean("usable_as_target").notNullable().defaultTo(false);
    });
  }

  // **The merged verdict is not a place and serves neither axis.**
  // `MERGED_REGION_ID` (0) is the computed answer across the other regions:
  // nothing observes there and nothing can be deployed there. The local check
  // (`LOCAL_REGION_ID`, -1) IS a probe location - it is this server checking the
  // thing itself - so it keeps the probe axis and only region 0 is cleared.
  //
  // Guarded on `addedProbe` so a re-run cannot undo an operator's later edit.
  // The column default has already filled every other row; this corrects the one
  // row the default is wrong for.
  if (addedProbe) {
    await knex(REGIONS).where("id", 0).update({ usable_as_probe: false });
  }
}

export async function down(knex: Knex): Promise<void> {
  // Postgres only, matching the convention the rest of this schema follows:
  // dropColumn on SQLite is a table rebuild, and rebuilding `regions` would
  // cascade through every foreign key that names it.
  if (knex.client.config.client !== "pg") return;
  if (!(await knex.schema.hasTable(REGIONS))) return;

  for (const column of ["usable_as_probe", "usable_as_target"]) {
    if (!(await knex.schema.hasColumn(REGIONS, column))) continue;
    await knex.schema.alterTable(REGIONS, (table) => table.dropColumn(column));
  }
}
