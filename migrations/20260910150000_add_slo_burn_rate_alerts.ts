import type { Knex } from "knex";

// F1b: burn-rate alerting on an SLO target.
//
// **Columns on `monitor_alerts_config` rather than a table of its own.** The
// alternative is a second copy of everything that table already owns: the
// fire-once state machine in `monitor_alerts_v2`, the trigger junction, incident
// creation, and the two outbox events. None of that is about monitors
// specifically; only the *subject* of the alert is, and that is one nullable
// column.
//
// **`sla_target_id` is what an SLO_BURN_RATE config watches**, in place of the
// monitors in `monitor_alerts_config_monitors`. The two are mutually exclusive
// in practice and deliberately not enforced by a constraint: `alert_for` already
// says which one is meaningful, and a CHECK spanning a junction table is not
// expressible anyway.
//
// **Two windows, not one.** A single short window is exactly what pages somebody
// for one bad five minutes. The classic multi-window rule is an AND across a
// fast and a slow window - 1h at 14.4 together with 6h at 6 - and the defaults
// the admin form offers are those numbers, so nobody has to know them to get the
// standard rule. They are columns rather than hard-coded presets because an
// operator running a 99.99% objective legitimately wants different ones.

const TABLE = "monitor_alerts_config";

/** Column name to its definition, applied only when absent. */
const COLUMNS: Array<[string, (table: Knex.CreateTableBuilder) => void]> = [
  ["sla_target_id", (table) => table.integer("sla_target_id").nullable()],
  // Window keys, matching `BURN_WINDOWS` in services/slo.ts: 1h, 6h, 24h, 3d.
  ["burn_window_a", (table) => table.string("burn_window_a", 8).nullable()],
  ["burn_threshold_a", (table) => table.double("burn_threshold_a").nullable()],
  ["burn_window_b", (table) => table.string("burn_window_b", 8).nullable()],
  ["burn_threshold_b", (table) => table.double("burn_threshold_b").nullable()],
];

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return;

  for (const [name, define] of COLUMNS) {
    if (await knex.schema.hasColumn(TABLE, name)) continue;
    await knex.schema.alterTable(TABLE, (table) => {
      define(table as unknown as Knex.CreateTableBuilder);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return;

  for (const [name] of COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, name))) continue;
    await knex.schema.alterTable(TABLE, (table) => {
      table.dropColumn(name);
    });
  }
}
