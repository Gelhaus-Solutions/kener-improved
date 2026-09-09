import type { Knex } from "knex";

// C2c: the five lifecycle timestamps, so MTTD, MTTA and MTTR stop being guesses.
//
// `incidents` records `start_date_time`, `end_date_time`, `created_at`,
// `updated_at`, `status` and `state`. None of those answer "when did we find
// out", so the only recoverable duration today is wall-clock incident length,
// which is the least useful of the four numbers an operator wants. This adds the
// points on the timeline and backfills them from evidence that already exists.
//
//   detected_at         first machine observation. Backfilled from
//                       monitor_alerts_v2.created_at, joined on incident_id.
//   acknowledged_at     first human ack. No historical source exists, so history
//                       gets null and an Acknowledge action fills it going
//                       forward.
//   identified_at       first entered IDENTIFIED. MIN(commented_at) on that state.
//   mitigated_at        first entered MONITORING. Same, on that state.
//   resolved_at         *last* entered RESOLVED, and only if it is closed now.
//                       MAX(commented_at), falling back to end_date_time.
//
// **What is deliberately not here is the true outage start.** C2c defines
// MTTD as `detected_at` minus the first non-UP minute, and specifies reading that
// minute from the P5 rollups. P5 has not landed, so there is nothing to read.
// Rather than store a number computed from a source that does not exist yet, the
// true start is computed at read time from `monitoring_data` in
// `src/lib/server/incidents/metrics.ts` - the same samples the rollups will
// aggregate, queried raw. When P5 lands, that query moves to the rollup table and
// the answer does not change. A stored column would have had to be recomputed
// then, and the recompute would have been the migration nobody remembered to run.
//
// The state values are the ones in `src/lib/global-constants.ts`, transcribed
// rather than imported: a migration that imports from `src/` breaks the moment
// the constant is renamed, and a migration that has already run against
// production must keep meaning what it meant when it ran.

const STATE_IDENTIFIED = "IDENTIFIED";
const STATE_MONITORING = "MONITORING";
const STATE_RESOLVED = "RESOLVED";

/**
 * A `timestamp` column as UTC seconds.
 *
 * Transcribed from `parseDbTimestamp` in `src/lib/server/tool.ts`, and the
 * regex branch is the whole point. SQLite stores `knex.fn.now()` as
 * `YYYY-MM-DD HH:MM:SS` with no zone marker, and `new Date()` reads a string in
 * that shape as **local** time. On a machine in Europe/Berlin that shifts every
 * backfilled `detected_at` by an hour or two, in the direction that makes
 * detection look like it happened before the outage did. Postgres hands back a
 * real Date and needs none of this, which is exactly why the bug would have
 * survived a Postgres-only test.
 */
function toUnixSeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") {
    // Already seconds if it is small enough to be, milliseconds otherwise.
    return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === "string") {
    const naive = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
    const parsed = new Date(naive ? value.replace(" ", "T") + "Z" : value);
    const ms = parsed.getTime();
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  return null;
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("incidents"))) return;

  const columns = [
    "detected_at",
    "acknowledged_at",
    "acknowledged_by_user_id",
    "identified_at",
    "mitigated_at",
    "resolved_at",
  ];

  for (const name of columns) {
    if (await knex.schema.hasColumn("incidents", name)) continue;
    await knex.schema.alterTable("incidents", (table) => {
      // No foreign key on `acknowledged_by_user_id`, and not out of laziness:
      // adding one on SQLite is a table rebuild, and rebuilding `incidents`
      // drops it, which cascades `monitor_alerts_v2.incident_id` to null. The
      // C2 migration documents that hazard at length. A deleted user leaving a
      // dangling id on a historical incident is a smaller problem than severed
      // alert history, and the UI resolves the id defensively anyway.
      table.integer(name).nullable();
    });
  }

  // ---- indexes -----------------------------------------------------------
  //
  // C2c is explicit that the metrics must not be precomputed: at a few hundred
  // incidents a year one indexed scan answers counts by severity, counts by
  // component and trends instantly, and a precomputed table would be a second
  // source of truth that drifts. These two indexes are what make that true.
  const hasOrgId = await knex.schema.hasColumn("incidents", "org_id");
  const indexes: Array<[string, string[]]> = hasOrgId
    ? [
        ["idx_incidents_org_start", ["org_id", "start_date_time"]],
        ["idx_incidents_org_severity_start", ["org_id", "severity", "start_date_time"]],
      ]
    : [
        ["idx_incidents_start", ["start_date_time"]],
        ["idx_incidents_severity_start", ["severity", "start_date_time"]],
      ];

  for (const [name, cols] of indexes) {
    if (await indexExists(knex, "incidents", name)) continue;
    await knex.schema.alterTable("incidents", (table) => {
      table.index(cols, name);
    });
  }

  // ---- backfill: detected_at ---------------------------------------------
  //
  // Only from alerts, and only the earliest one. An incident may have collected
  // several alert rows over its life - a config that re-fires, a second monitor
  // joining the same incident - and detection is the first of them, not the last.
  //
  // A dashboard-created incident gets null, because no machine observed it. That
  // is not a gap to paper over: `metrics.ts` falls back to `start_date_time` for
  // the MTTR arithmetic, so a manual incident still produces a number, and MTTD
  // stays null for it because there genuinely was no detection to measure.
  if (await knex.schema.hasTable("monitor_alerts_v2")) {
    const alerts: Array<{ incident_id: number; created_at: unknown }> = await knex("monitor_alerts_v2")
      .whereNotNull("incident_id")
      .select("incident_id", "created_at");

    const earliest = new Map<number, number>();
    for (const row of alerts) {
      const seconds = toUnixSeconds(row.created_at);
      if (seconds === null) continue;
      const current = earliest.get(row.incident_id);
      if (current === undefined || seconds < current) earliest.set(row.incident_id, seconds);
    }

    for (const [incidentId, seconds] of earliest) {
      await knex("incidents").where("id", incidentId).whereNull("detected_at").update({ detected_at: seconds });
    }
  }

  // ---- backfill: identified_at, mitigated_at, resolved_at -----------------
  //
  // `commented_at` is already UTC seconds, so these need no conversion.
  //
  // **MIN for the first two, MAX for resolution, and the asymmetry is the
  // point.** An incident that went IDENTIFIED, slipped back to INVESTIGATING and
  // was identified again was identified at the first one: identification is a
  // thing you learn and do not unlearn. Resolution is not - an incident that was
  // resolved, reopened and resolved again was actually over at the *second* one,
  // and taking the first would report an MTTR that ends before the outage did.
  // `end_date_time` agrees, because the reopen nulls it and the re-resolve sets
  // it to the later time.
  if (await knex.schema.hasTable("incident_comments")) {
    const stateColumns: Array<[string, string, "min" | "max"]> = [
      [STATE_IDENTIFIED, "identified_at", "min"],
      [STATE_MONITORING, "mitigated_at", "min"],
      [STATE_RESOLVED, "resolved_at", "max"],
    ];

    for (const [state, column, aggregate] of stateColumns) {
      const base = knex("incident_comments").where("state", state).groupBy("incident_id").select("incident_id");
      const rows: Array<{ incident_id: number; at: number | string }> =
        aggregate === "min" ? await base.min({ at: "commented_at" }) : await base.max({ at: "commented_at" });

      for (const row of rows) {
        const seconds = typeof row.at === "string" ? parseInt(row.at, 10) : row.at;
        if (!Number.isFinite(seconds)) continue;

        // Only for an incident that is actually closed. A reopened incident has
        // a RESOLVED comment in its history and is not resolved now; writing
        // `resolved_at` on it would make an open incident report an MTTR, and
        // every "incidents resolved this month" count would include one that is
        // still running.
        const query = knex("incidents").where("id", row.incident_id).whereNull(column);
        if (column === "resolved_at") query.whereNotNull("end_date_time");

        await query.update({ [column]: seconds });
      }
    }
  }

  // An incident closed without a RESOLVED comment - closed from the API, or by
  // an alert that set the end time directly - still resolved, and end_date_time
  // is when. Applied after the comment pass and guarded on null, so a real
  // RESOLVED comment always wins over the coarser fallback.
  await knex("incidents")
    .whereNull("resolved_at")
    .whereNotNull("end_date_time")
    .update({ resolved_at: knex.ref("end_date_time") });
}

/**
 * Whether an index exists, without asking the database to fail.
 *
 * knex has no portable "create index if not exists", and the usual dodge is a
 * try/catch around the create. That is forbidden on Postgres for a real reason:
 * a failed statement aborts the surrounding transaction, and knex runs every
 * migration in one, so the catch swallows the error and every statement after it
 * fails with "current transaction is aborted" instead. Asking first is the only
 * version that works on both dialects.
 */
async function indexExists(knex: Knex, table: string, name: string): Promise<boolean> {
  const client = knex.client.config.client;
  if (client === "pg") {
    const result = await knex.raw(`select 1 from pg_indexes where tablename = ? and indexname = ?`, [table, name]);
    return result.rows.length > 0;
  }
  if (client === "mysql" || client === "mysql2") {
    const result = await knex.raw(
      `select 1 from information_schema.statistics where table_schema = database() and table_name = ? and index_name = ?`,
      [table, name],
    );
    return (result[0] as unknown[]).length > 0;
  }
  const rows = await knex.raw(`PRAGMA index_list(${knex.client.wrapIdentifier(table, (x: string) => x)})`);
  return (rows as Array<{ name: string }>).some((r) => r.name === name);
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("incidents"))) return;

  for (const name of ["idx_incidents_org_start", "idx_incidents_org_severity_start"]) {
    if (!(await indexExists(knex, "incidents", name))) continue;
    await knex.schema.alterTable("incidents", (table) => {
      table.dropIndex([], name);
    });
  }

  // Postgres only, for the reason C2's down() spells out: dropColumn on SQLite
  // rebuilds the table, and rebuilding `incidents` nulls
  // `monitor_alerts_v2.incident_id` on every alert that ever opened one. Six
  // unused columns are cheaper than severed alert history.
  if (knex.client.config.client === "pg") {
    for (const name of [
      "detected_at",
      "acknowledged_at",
      "acknowledged_by_user_id",
      "identified_at",
      "mitigated_at",
      "resolved_at",
    ]) {
      if (!(await knex.schema.hasColumn("incidents", name))) continue;
      await knex.schema.alterTable("incidents", (table) => {
        table.dropColumn(name);
      });
    }
  } else {
    console.log(
      "incident lifecycle timestamps: leaving the columns in place on SQLite; dropping them rebuilds the table and would null monitor_alerts_v2.incident_id",
    );
  }
}
