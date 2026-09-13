import type { Knex } from "knex";

// E11 part 4: batching and a rate ceiling, per endpoint.
//
// Some event types fire far more than others - `incident.comment_added` on a
// busy incident, `probe.connected` on a flapping agent - and the only control
// today is a flat on/off per type. Turning the type off loses the signal
// entirely, so the operator's real choice is "be spammed" or "be blind".
//
// Two independent knobs, both nullable, both off by default so no existing
// endpoint changes behaviour:
//
//   batch_window_seconds  collapse a burst. Events arriving in the same window
//                         are delivered as ONE request carrying all of them.
//                         Nothing is dropped; it just arrives together.
//
//   max_per_minute        a hard ceiling. Deliveries over it are postponed, not
//                         discarded, so a flapping agent cannot drown a channel
//                         and cannot lose an event either.
//
// **Neither ever drops an event, and that is the design rule.** The delivery log
// is the evidence trail for an outbound integration; an event that silently
// vanished because a counter was high would be indistinguishable from a bug in
// the relay, which is the failure mode this whole subsystem is built to avoid.
//
// `batch_id` on `event_deliveries` is what keeps the log honest. Enno's decision
// was one row per EVENT with a shared attempt id, rather than one row per
// request: every event stays individually traceable and the existing delivery
// screen keeps working unchanged, while rows that travelled in one request can
// still be grouped.
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable("webhook_endpoints")) {
    const columns: Array<[string, (table: Knex.AlterTableBuilder) => void]> = [
      ["batch_window_seconds", (table) => table.integer("batch_window_seconds").nullable()],
      ["max_per_minute", (table) => table.integer("max_per_minute").nullable()],
    ];

    for (const [name, add] of columns) {
      if (await knex.schema.hasColumn("webhook_endpoints", name)) continue;
      await knex.schema.alterTable("webhook_endpoints", add);
    }
  }

  if (await knex.schema.hasTable("event_deliveries")) {
    if (!(await knex.schema.hasColumn("event_deliveries", "batch_id"))) {
      await knex.schema.alterTable("event_deliveries", (table) => {
        // A ULID, matching `event_id`. Null for every delivery that travelled on
        // its own, which is all of them until an endpoint is given a window.
        table.string("batch_id", 26).nullable();
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // Postgres only, matching the convention the incident-timestamp migration
  // established: dropColumn on SQLite rebuilds the table, and rebuilding
  // `event_deliveries` would sever the delivery history these columns annotate.
  if (knex.client.config.client !== "pg") return;

  if (await knex.schema.hasTable("webhook_endpoints")) {
    for (const name of ["batch_window_seconds", "max_per_minute"]) {
      if (!(await knex.schema.hasColumn("webhook_endpoints", name))) continue;
      await knex.schema.alterTable("webhook_endpoints", (table) => table.dropColumn(name));
    }
  }

  if (await knex.schema.hasTable("event_deliveries")) {
    if (await knex.schema.hasColumn("event_deliveries", "batch_id")) {
      await knex.schema.alterTable("event_deliveries", (table) => table.dropColumn("batch_id"));
    }
  }
}
