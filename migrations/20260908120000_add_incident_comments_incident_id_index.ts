import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // incident_comments has been queried by incident_id since it was created, in
  // six places in repositories/incidents.ts, several of them with
  // whereIn("incident_id", ...) on the notifications path the public page polls.
  // There was never an index, so every one of those was a full scan.
  if (!(await knex.schema.hasTable("incident_comments"))) return;
  try {
    await knex.schema.alterTable("incident_comments", (table) => {
      table.index(["incident_id"], "idx_incident_comments_incident_id");
    });
  } catch (_e) {
    /* index already exists */
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("incident_comments"))) return;
  await knex.schema.alterTable("incident_comments", (table) => {
    table.dropIndex(["incident_id"], "idx_incident_comments_incident_id");
  });
}
