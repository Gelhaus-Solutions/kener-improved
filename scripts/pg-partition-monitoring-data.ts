/**
 * Converts `monitoring_data` into a declaratively-partitioned table (B1a).
 *
 * `npm run pg:partition-monitoring-data`
 *
 * **Postgres only, operator-run, and resumable.** It is not a migration on
 * purpose. knex wraps a migration in one transaction, and copying a multi-GB
 * table takes long enough that the container healthcheck kills the process
 * mid-copy - after which the next boot starts the copy over, forever. This runs
 * when somebody is watching, and picks up where it left off if it is
 * interrupted.
 *
 * **What it buys.** Retention deletes about a day of `monitoring_data` a night.
 * On an ordinary table those deletes leave dead tuples that autovacuum reaches
 * days later, which is the entire reason
 * `20260831120000_monitoring_data_autovacuum.ts` exists. On a partitioned table,
 * dropping a month is a catalogue update: instant, and it leaves nothing behind
 * to vacuum.
 *
 * **The shape of the run:**
 *
 *   1. Refuse unless this is Postgres and the table is not already partitioned.
 *   2. Build `monitoring_data_partitioned`, a partitioned parent with the same
 *      columns, the same key and the same indexes under temporary names.
 *   3. Create a monthly partition for every month the data touches, plus
 *      `monitoring_data_default` as the safety net.
 *   4. Copy ascending by timestamp in chunks, `ON CONFLICT DO NOTHING`, so a
 *      re-run repeats at most one chunk.
 *   5. Swap under ACCESS EXCLUSIVE in one transaction: catch up on anything
 *      written during the copy, verify the counts match, rename.
 *
 * **The old table is renamed, never dropped.** It becomes
 * `monitoring_data_pre_partition` and stays until an operator drops it by hand.
 * A script that reclaims the disk itself is a script that cannot be undone if
 * the verification was wrong about something it did not think to check.
 *
 * Environment:
 *   DATABASE_URL              as usual; must be postgresql://
 *   PARTITION_CHUNK_DAYS      days of samples copied per statement (default 7)
 *   PARTITION_DRY_RUN=1       report the plan and exit without writing
 */

import knexLib from "knex";
import type { Knex } from "knex";
import knexOb from "../knexfile.js";
import {
  DEFAULT_PARTITION,
  MONTHS_AHEAD,
  monthBounds,
  monthsBetween,
  partitionName,
} from "../src/lib/server/db/partitions.js";

const TABLE = "monitoring_data";
const STAGING = "monitoring_data_partitioned";
const RETIRED = "monitoring_data_pre_partition";

/**
 * The indexes the staging table is built with, and the names they take at the
 * swap.
 *
 * They have to be created under other names because the live table still holds
 * these ones, and two relations in a schema cannot share a name. The swap
 * renames the old table's indexes out of the way and these into place, so that
 * after the conversion the schema looks exactly like the migration left it.
 */
const INDEXES: Array<{ finalName: string; columns: string[] }> = [
  {
    finalName: "idx_monitoring_data_tag_region_ts_status_latency",
    columns: ["monitor_tag", "region_id", "timestamp", "status", "latency"],
  },
  { finalName: "idx_monitoring_data_tag_region_type_ts", columns: ["monitor_tag", "region_id", "type", "timestamp"] },
  { finalName: "idx_monitoring_data_timestamp", columns: ["timestamp"] },
  { finalName: "idx_monitoring_data_org_id", columns: ["org_id"] },
];

const PK_COLUMNS = ["monitor_tag", "region_id", "timestamp"];
const PK_FINAL_NAME = "monitoring_data_pkey";
const PK_STAGING_NAME = "monitoring_data_partitioned_pkey";

const stagingIndexName = (finalName: string) => `${finalName}__part`;
const retiredName = (name: string) => `${name}__pre_part`;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** See `partitions.ts`: DDL takes no bind parameters, so bounds go in as text. */
function lit(ts: number): string {
  if (!Number.isSafeInteger(ts)) throw new Error(`Refusing to build a partition bound from ${ts}`);
  return String(ts);
}

async function scalar<T>(knex: Knex, sql: string, bindings: Knex.RawBinding[] = []): Promise<T | undefined> {
  const result = await knex.raw(sql, bindings);
  const rows = ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return undefined;
  return Object.values(rows[0])[0] as T;
}

async function relationKind(knex: Knex, name: string): Promise<string | null> {
  const kind = await scalar<string>(
    knex,
    `select c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relname = ? and n.nspname = current_schema()`,
    [name],
  );
  return kind ?? null;
}

async function indexExists(knex: Knex, name: string): Promise<boolean> {
  const found = await scalar<number>(
    knex,
    `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relname = ? and n.nspname = current_schema() and c.relkind in ('i','I')`,
    [name],
  );
  return found !== undefined;
}

async function main(): Promise<void> {
  if (knexOb.databaseType !== "postgresql") {
    console.error(`This script is PostgreSQL-only; DATABASE_URL says "${knexOb.databaseType}".`);
    console.error("SQLite and MySQL keep an unpartitioned table and range-delete retention, by design.");
    process.exit(1);
  }

  const dryRun = process.env.PARTITION_DRY_RUN === "1";
  const chunkDays = intFromEnv("PARTITION_CHUNK_DAYS", 7);
  const chunkSeconds = chunkDays * 86400;

  const knex = knexLib(knexOb as unknown as Knex.Config);

  try {
    const kind = await relationKind(knex, TABLE);
    if (kind === null) {
      console.error(`No table named ${TABLE} in the current schema. Run migrations first.`);
      process.exit(1);
    }
    if (kind === "p") {
      console.log(`${TABLE} is already partitioned. Nothing to do.`);
      return;
    }

    const total = Number(await scalar<string>(knex, `select count(*) from ??`, [TABLE]));
    const size = await scalar<string>(knex, `select pg_size_pretty(pg_total_relation_size(?::regclass))`, [TABLE]);
    const lo = await scalar<string>(knex, `select min("timestamp") from ??`, [TABLE]);
    const hi = await scalar<string>(knex, `select max("timestamp") from ??`, [TABLE]);

    console.log(`${TABLE}: ${total.toLocaleString("en-US")} rows, ${size}`);

    if (total === 0) {
      console.log("Empty table. Converting is still worth doing, and instant.");
    } else {
      console.log(
        `Samples span ${new Date(Number(lo) * 1000).toISOString()} to ${new Date(Number(hi) * 1000).toISOString()}`,
      );
    }

    // Partitions cover the data plus MONTHS_AHEAD forward, so the first writes
    // after the swap have somewhere to land without waiting for the daily
    // scheduler's next pass.
    const nowTs = Math.floor(Date.now() / 1000);
    const firstTs = total === 0 ? nowTs : Number(lo);
    let latest = monthBounds(nowTs).start;
    for (let i = 0; i < MONTHS_AHEAD; i++) latest = monthBounds(latest).end;
    const months = monthsBetween(firstTs, latest);

    console.log(
      `Plan: ${months.length} monthly partitions plus ${DEFAULT_PARTITION}, copied in ${chunkDays}-day chunks.`,
    );

    if (dryRun) {
      console.log("PARTITION_DRY_RUN=1 — stopping before any write.");
      return;
    }

    // ---- staging parent -------------------------------------------------
    //
    // `LIKE ... INCLUDING DEFAULTS` rather than a hand-written column list, so
    // a column added to `monitoring_data` by a later migration is carried over
    // without anybody remembering to edit this file. Indexes are deliberately
    // NOT included: they would arrive under generated names that collide with
    // the live table's, and the swap needs to control those names.
    if ((await relationKind(knex, STAGING)) === null) {
      await knex.raw(`CREATE TABLE ?? (LIKE ?? INCLUDING DEFAULTS) PARTITION BY RANGE ("timestamp")`, [STAGING, TABLE]);
      console.log(`Created ${STAGING}`);
    } else {
      console.log(`${STAGING} already exists — resuming.`);
    }

    // A partitioned table's primary key must contain the partition key.
    // `timestamp` is already in it, which is what makes range partitioning on
    // timestamp possible at all without widening the key.
    if (!(await indexExists(knex, PK_STAGING_NAME))) {
      await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? PRIMARY KEY (${PK_COLUMNS.map(() => "??").join(", ")})`, [
        STAGING,
        PK_STAGING_NAME,
        ...PK_COLUMNS,
      ]);
      console.log(`Added ${PK_STAGING_NAME}`);
    }

    for (const index of INDEXES) {
      const name = stagingIndexName(index.finalName);
      if (await indexExists(knex, name)) continue;
      await knex.raw(`CREATE INDEX ?? ON ?? (${index.columns.map(() => "??").join(", ")})`, [
        name,
        STAGING,
        ...index.columns,
      ]);
      console.log(`Created ${name}`);
    }

    // ---- partitions -----------------------------------------------------
    if ((await relationKind(knex, DEFAULT_PARTITION)) === null) {
      await knex.raw(`CREATE TABLE ?? PARTITION OF ?? DEFAULT`, [DEFAULT_PARTITION, STAGING]);
    }
    for (const month of months) {
      const { year, month1 } = monthBounds(month.start);
      const name = partitionName(year, month1);
      if ((await relationKind(knex, name)) !== null) continue;
      await knex.raw(`CREATE TABLE ?? PARTITION OF ?? FOR VALUES FROM (${lit(month.start)}) TO (${lit(month.end)})`, [
        name,
        STAGING,
      ]);
    }
    console.log(`Partitions ready.`);

    // ---- copy -----------------------------------------------------------
    //
    // Resumable without a cursor table. Every chunk is `ON CONFLICT DO
    // NOTHING`, so re-copying one is free, and the resume point is simply the
    // start of the chunk containing the highest timestamp already copied. An
    // interrupted run therefore repeats at most one chunk.
    if (total > 0) {
      const copiedHigh = await scalar<string>(knex, `select max("timestamp") from ??`, [STAGING]);
      let cursor = Number(lo);
      if (copiedHigh !== null && copiedHigh !== undefined) {
        cursor = Math.floor(Number(copiedHigh) / chunkSeconds) * chunkSeconds;
        console.log(`Resuming from ${new Date(cursor * 1000).toISOString()}`);
      }

      const end = Number(hi);
      let copied = 0;
      while (cursor <= end) {
        const next = cursor + chunkSeconds;
        const result = await knex.raw(
          `INSERT INTO ?? SELECT * FROM ?? WHERE "timestamp" >= ? AND "timestamp" < ? ON CONFLICT DO NOTHING`,
          [STAGING, TABLE, cursor, next],
        );
        copied += (result as { rowCount?: number }).rowCount ?? 0;
        const pct = Math.min(100, Math.round(((cursor - Number(lo)) / Math.max(1, end - Number(lo))) * 100));
        process.stdout.write(`\rCopying… ${pct}% (${copied.toLocaleString("en-US")} rows)   `);
        cursor = next;
      }
      process.stdout.write("\n");
    }

    // ---- swap -----------------------------------------------------------
    //
    // One transaction, one exclusive lock, held for a catch-up copy of whatever
    // the running app wrote during the bulk copy plus four renames. The
    // catch-up is small because the bulk copy already covered everything older.
    await knex.transaction(async (trx) => {
      await trx.raw(`LOCK TABLE ?? IN ACCESS EXCLUSIVE MODE`, [TABLE]);

      // Everything, not just the tail: a backfilled incident overlay can write
      // into an old month while the copy is running, and ON CONFLICT DO NOTHING
      // makes covering the whole range cost only the rows that are new.
      await trx.raw(`INSERT INTO ?? SELECT * FROM ?? ON CONFLICT DO NOTHING`, [STAGING, TABLE]);

      const before = Number(await scalar<string>(trx, `select count(*) from ??`, [TABLE]));
      const after = Number(await scalar<string>(trx, `select count(*) from ??`, [STAGING]));
      if (before !== after) {
        // Aborts the transaction, so the live table is untouched and the staging
        // table survives for inspection. A mismatch here means a row failed the
        // conflict check or landed outside every partition, and guessing which
        // is not this script's job.
        throw new Error(`Row count mismatch: ${TABLE} has ${before}, ${STAGING} has ${after}. Nothing was swapped.`);
      }

      await trx.raw(`ALTER TABLE ?? RENAME TO ??`, [TABLE, RETIRED]);
      if (await indexExists(trx, PK_FINAL_NAME)) {
        await trx.raw(`ALTER INDEX ?? RENAME TO ??`, [PK_FINAL_NAME, retiredName(PK_FINAL_NAME)]);
      }
      for (const index of INDEXES) {
        if (await indexExists(trx, index.finalName)) {
          await trx.raw(`ALTER INDEX ?? RENAME TO ??`, [index.finalName, retiredName(index.finalName)]);
        }
      }

      await trx.raw(`ALTER TABLE ?? RENAME TO ??`, [STAGING, TABLE]);
      await trx.raw(`ALTER INDEX ?? RENAME TO ??`, [PK_STAGING_NAME, PK_FINAL_NAME]);
      for (const index of INDEXES) {
        await trx.raw(`ALTER INDEX ?? RENAME TO ??`, [stagingIndexName(index.finalName), index.finalName]);
      }

      console.log(`Swapped. ${after.toLocaleString("en-US")} rows verified.`);
    });

    // The partitioned table inherits none of the old table's planner statistics.
    await knex.raw(`ANALYZE ??`, [TABLE]);

    const stranded = Number(await scalar<string>(knex, `select count(*) from ??`, [DEFAULT_PARTITION]));
    if (stranded > 0) {
      console.warn(`WARNING: ${stranded} row(s) landed in ${DEFAULT_PARTITION}, outside every monthly partition.`);
      console.warn("They are readable and correct, but the month covering them can no longer be attached.");
    }

    console.log("");
    console.log(`Done. The old table is kept as ${RETIRED}.`);
    console.log(`Verify the app, then reclaim the space with:  DROP TABLE ${RETIRED};`);
  } finally {
    await knex.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
