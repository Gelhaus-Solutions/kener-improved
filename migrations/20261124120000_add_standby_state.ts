import type { Knex } from "knex";

// One row (id 1) a standby writes after each pull from its primary, and reads to
// decide whether its data is still current. Empty on a primary.
const TABLE = "standby_state";

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (table) => {
    table.integer("id").primary();
    /** Standby clock, UTC seconds: when the last pull finished. Staleness is measured from this. */
    table.integer("last_pull_at").nullable();
    /** Primary clock: when the last good pull's data was read. Shown in the banner, and the next pull's cursor. */
    table.integer("data_at").nullable();
    table.string("schema_version", 255).nullable();
    table.string("images_fingerprint", 64).nullable();
    table.integer("last_attempt_at").nullable();
    table.text("last_error").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE);
}
