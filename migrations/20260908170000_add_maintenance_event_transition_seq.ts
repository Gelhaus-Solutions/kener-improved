import type { Knex } from "knex";

// A monotonic counter of status changes per maintenance event.
//
// The event bus deduplicates by `idempotency_key`, and the natural key for a
// maintenance transition is `maintenance.started:{event_id}`. That is wrong on
// its own, because an event can legitimately enter the same status twice:
// `UpdateMaintenanceEventStatuses` reaches ONGOING by two different routes (the
// READY path and the catch-up path for an event that missed its READY window),
// and rescheduling can send an event back to SCHEDULED to start again. With the
// naive key the second, genuine transition is silently swallowed and nobody is
// told the maintenance began.
//
// So the key becomes `maintenance.started:{event_id}:{transition_seq}`, which
// still collapses a retried job (same seq) while letting a real re-entry through
// (new seq). The counter is bumped by the repository on every status write, so
// no caller has to remember to.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("maintenances_events"))) return;
  if (await knex.schema.hasColumn("maintenances_events", "transition_seq")) return;

  await knex.schema.alterTable("maintenances_events", (table) => {
    // Existing rows start at 0. Their first transition after this migration
    // becomes 1, which is a key nothing has used, so no historical event is
    // suppressed by a key left over from before the column existed.
    table.integer("transition_seq").notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("maintenances_events"))) return;
  if (!(await knex.schema.hasColumn("maintenances_events", "transition_seq"))) return;
  await knex.schema.alterTable("maintenances_events", (table) => {
    table.dropColumn("transition_seq");
  });
}
