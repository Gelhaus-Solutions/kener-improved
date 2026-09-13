import type { Knex } from "knex";

// B13 stage 1: where a region actually is, so it can be drawn on a map.
//
// `regions` carries a code, a name and its merge defaults, and nothing that
// says where on earth it is. The map cannot exist without that.
//
// **Nullable, and that is load-bearing rather than lazy.** A region with no
// coordinates has to stay completely usable - it still votes, still records
// samples, still appears in every list - and simply not appear on the map. The
// alternative to nullable is a default, and the only available default is 0,0,
// which is in the Gulf of Guinea. A pin sitting in the ocean off west Africa is
// worse than an absent pin: it is a confident, wrong answer, and an operator who
// has not set coordinates has said nothing that justifies one.
//
// Stored as a real rather than a string: these are plotted arithmetically, and a
// numeric column is what makes an out-of-range value a database error rather
// than a pin outside the canvas.
const REGIONS = "regions";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(REGIONS))) return;

  if (!(await knex.schema.hasColumn(REGIONS, "latitude"))) {
    await knex.schema.alterTable(REGIONS, (table) => {
      // Degrees north, -90 to 90.
      table.float("latitude").nullable();
    });
  }

  if (!(await knex.schema.hasColumn(REGIONS, "longitude"))) {
    await knex.schema.alterTable(REGIONS, (table) => {
      // Degrees east, -180 to 180.
      table.float("longitude").nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  // Postgres only, matching the convention the rest of this schema follows:
  // dropColumn on SQLite is a table rebuild, and rebuilding `regions` would
  // cascade through every foreign key that names it.
  if (knex.client.config.client !== "pg") return;
  if (!(await knex.schema.hasTable(REGIONS))) return;

  for (const column of ["latitude", "longitude"]) {
    if (!(await knex.schema.hasColumn(REGIONS, column))) continue;
    await knex.schema.alterTable(REGIONS, (table) => table.dropColumn(column));
  }
}
