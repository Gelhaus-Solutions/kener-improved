import type { Knex } from "knex";

// F6b: how the rollups know what to compute, and what to recompute.
//
// Two small tables, and the split between them is the design:
//
//   `rollup_state` is **how far forward** each grain has got, per org and
//   region. One row per (org, grain, region), holding a watermark and the
//   backfill's own resumable cursor.
//
//   `rollup_dirty` is **what went backwards**. Kener rewrites history in three
//   places - a confirmation-threshold flip restating past minutes, the admin
//   overlay rewriting a window, and a monitor's data being deleted - and each
//   one invalidates buckets that are already computed and already behind the
//   watermark. A row here is an hour that must be recomputed regardless of the
//   watermark.
//
// **The dirty unit is one HOUR, not one bucket, and that is the load-bearing
// decision in this file.** A per-bucket set is the obvious design and it does
// not survive contact with C7: a backfilled incident rewrites up to 100,000
// minutes of a monitor's history in one transaction, which is 20,000 five-minute
// buckets, and `deleteMonitorDataByTag` on a monitor with years of history is
// unbounded. At an hour the same backfill is 1,667 rows, and a 90-day rewrite is
// 2,160 rather than 25,920.
//
// It costs a little precision in the other direction: a three-minute
// confirmation flip dirties a whole hour and so recomputes sixty raw samples
// instead of five. That is the right trade - flips are rare and small, rewrites
// are occasional and enormous, and only one of those two can take the system
// down.
//
// There is no `grain` column for the same reason. A recompute always cascades
// upward - the twelve 5m buckets, then the hour folded from them, then the day
// folded from its twenty-four hours - so a design that could mark 5m dirty
// without marking 1h dirty would only be able to represent inconsistent states.
//
// **Every bucket is recomputed by a full aggregate over its source rows and
// upserted, never incremented.** That one decision is why the dirty set can be
// this simple: late data, a BullMQ retry, a confirmation backfill and an overlay
// rewrite are all the same operation, which is "mark it, compute it again". An
// incremental design would need to know what the previous value was and what
// exactly changed, and would be wrong the first time a job ran twice.
//
// **`backfill_complete` is the kill switch.** The read path checks it and falls
// back to the existing raw SQL while it is false, so the whole rollup layer
// ships dark and can be switched off by setting one column back.

const STATE = "rollup_state";
const DIRTY = "rollup_dirty";

function isPg(knex: Knex): boolean {
  return knex.client.config.client === "pg";
}

function isMysql(knex: Knex): boolean {
  const client = knex.client.config.client;
  return client === "mysql" || client === "mysql2";
}

/** Asked rather than attempted: MySQL has no `CREATE INDEX IF NOT EXISTS`, and on
 * Postgres a failed statement aborts the migration's whole transaction. */
async function hasIndex(knex: Knex, table: string, indexName: string): Promise<boolean> {
  if (isPg(knex)) {
    const result = await knex.raw(
      `select 1 from pg_indexes where schemaname = current_schema() and tablename = ? and indexname = ?`,
      [table, indexName],
    );
    return (((result as { rows?: unknown[] }).rows ?? []) as unknown[]).length > 0;
  }
  if (isMysql(knex)) {
    const result = await knex.raw(
      `select 1 as found from information_schema.statistics
        where table_schema = database() and table_name = ? and index_name = ? limit 1`,
      [table, indexName],
    );
    const rows = Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : [];
    return (rows as unknown[]).length > 0;
  }
  const result = await knex.raw(`select name from sqlite_master where type = 'index' and name = ?`, [indexName]);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? [])) as unknown[];
  return rows.length > 0;
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(STATE))) {
    await knex.schema.createTable(STATE, (table) => {
      table.integer("org_id").notNullable();
      // '5m' | '1h' | '1d'. A string rather than a lookup table: three values
      // that will not change, and the grain is readable in a psql session.
      table.string("grain", 8).notNullable();
      table.integer("region_id").notNullable();

      /**
       * Buckets strictly below this are computed and trustworthy.
       *
       * Held deliberately behind `now`, by the scheduler's lag, so that a bucket
       * is never sealed while its source minutes can still arrive or be
       * rewritten by a confirmation flip.
       */
      table.integer("watermark_ts").nullable();

      /**
       * The kill switch, and the reason the read path can ship before the data
       * does. False means "the history behind the watermark is incomplete", so
       * the read path uses raw SQL and the rollups are written but not believed.
       */
      table.boolean("backfill_complete").notNullable().defaultTo(false);

      /** Oldest-to-newest walk position, so an interrupted backfill resumes. */
      table.integer("backfill_cursor_ts").nullable();
      table.integer("backfill_started_at").nullable();
      table.integer("backfill_completed_at").nullable();

      table.integer("updated_at").notNullable().defaultTo(0);

      table.primary(["org_id", "grain", "region_id"]);
    });
  }

  if (!(await knex.schema.hasTable(DIRTY))) {
    await knex.schema.createTable(DIRTY, (table) => {
      table.integer("org_id").notNullable();
      table.string("monitor_tag", 255).notNullable();
      table.integer("region_id").notNullable();
      /** The start of the UTC hour to recompute. See the header for why an hour. */
      table.integer("hour_start").notNullable();
      table.integer("marked_at").notNullable().defaultTo(0);

      // The whole row is the key, so marking the same hour twice is an upsert
      // that does nothing rather than a duplicate to deduplicate later. A
      // confirmation flip replayed by a BullMQ retry marks the same hour again
      // and changes nothing.
      table.primary(["org_id", "monitor_tag", "region_id", "hour_start"]);

      // No foreign key to `monitors`. A dirty row outliving its monitor is
      // harmless - the recompute finds no samples and deletes the buckets - and
      // a cascade here would mean `deleteMonitorDataByTag` silently dropped the
      // very marks it had just made.
    });
  }

  const drainIndex = `idx_${DIRTY}_org_marked`;
  if (!(await hasIndex(knex, DIRTY, drainIndex))) {
    await knex.schema.alterTable(DIRTY, (table) => {
      table.index(["org_id", "marked_at"], drainIndex);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(DIRTY);
  await knex.schema.dropTableIfExists(STATE);
}
