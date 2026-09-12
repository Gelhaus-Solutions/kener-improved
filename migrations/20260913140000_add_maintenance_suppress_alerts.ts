import type { Knex } from "knex";

// D4. Whether a maintenance window silences alerting, as a per-window choice.
//
// **Why it needs a column rather than being the overlay's side effect.** Today
// suppression is not a decision anybody made, it is a consequence: the overlay
// writes rows of type MAINTENANCE, alert evaluation reads only
// `ALERT_VISIBLE_TYPES`, and MAINTENANCE is not in that list, so the alert window
// freezes. That is the right default and it stays the default here. What it
// cannot express is the window where an operator explicitly wants to keep being
// paged - a risky migration they are watching, where "the site went down during
// the window" is the single most important thing to be told.
//
// **`YES` on every existing row, and that is the whole upgrade story.** Every
// window that exists today suppresses, because that is what it did yesterday. An
// operator who wants the other behaviour opts in per window.
//
// The alert path reads `monitoring_data.raw_status` for a non-suppressing
// window, which is why this is one column and not a rework of the write path:
// the overlay has preserved the monitor's own observed status there since the
// confirmation threshold landed, so the true status is already recorded next to
// the published one.

const TABLE = "maintenances";
const COLUMN = "suppress_alerts";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, COLUMN)) return;

  await knex.schema.alterTable(TABLE, (table) => {
    // YES | NO, matching the `is_global` and `status` columns beside it rather
    // than introducing a boolean into a table that spells every flag this way.
    table.string(COLUMN, 8).notNullable().defaultTo("YES");
  });
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return;

  await knex.schema.alterTable(TABLE, (table) => {
    table.dropColumn(COLUMN);
  });
}
