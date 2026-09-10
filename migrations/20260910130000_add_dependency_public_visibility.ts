import type { Knex } from "knex";

// Whether a component's dependency graph is shown to the public.
//
// **Why a column on `monitor_rollup_settings` rather than on `monitors`.** The
// same reason C3 put the rollup settings there in the first place:
// `appScheduler.ts` keys a monitor's BullMQ scheduler on
// `HashString(JSON.stringify(monitor))` and tears it down and recreates it
// whenever that hash moves. A new column on `monitors` would therefore restart a
// monitor's checks because somebody toggled what its status page shows, which is
// an absurd thing for a display preference to do.
//
// **Default 'YES', and absence also means yes.** A monitor with edges but no
// settings row is the common case - the row is only written when somebody sets a
// rollup mode or a pin - so the reader has to treat a missing row as visible or
// the feature would be invisible for exactly the monitors nobody has configured.
// The column default matches that reading so the two cannot drift.

const ROLLUP_SETTINGS = "monitor_rollup_settings";
const COLUMN = "show_dependencies";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(ROLLUP_SETTINGS))) return;
  if (await knex.schema.hasColumn(ROLLUP_SETTINGS, COLUMN)) return;

  await knex.schema.alterTable(ROLLUP_SETTINGS, (table) => {
    // A string rather than a boolean, matching `monitors.is_hidden` and
    // `include_degraded_in_downtime`: this codebase already reads YES/NO
    // everywhere, and SQLite storing a boolean as 0/1 while Postgres stores a
    // real boolean is a dialect difference worth not having.
    table.string(COLUMN, 3).notNullable().defaultTo("YES");
  });
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(ROLLUP_SETTINGS))) return;
  if (!(await knex.schema.hasColumn(ROLLUP_SETTINGS, COLUMN))) return;
  await knex.schema.alterTable(ROLLUP_SETTINGS, (table) => {
    table.dropColumn(COLUMN);
  });
}
