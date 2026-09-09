import type { Knex } from "knex";

// F6a: the three rollup grains.
//
// There is no aggregate table in Kener today. Retention is a nightly hard
// DELETE and nothing else, so every uptime number on every page is computed by
// scanning raw `monitoring_data` - up to 129,600 rows per monitor for a 90-day
// bar - and once retention has removed those rows the number cannot be computed
// at all. Everything in reporting stands on these three tables.
//
// **Why three grains rather than a daily table.** The 90-day bar is bucketed in
// the *viewer's* timezone, not UTC: `endOfDayTodayAtTz` flows from
// `src/lib/client/datetime.ts` into the public page. IANA offsets include `:30`
// and `:45` - Kolkata, Kathmandu, Chatham - so a UTC-day rollup simply cannot
// serve those viewers, and snapping them to the nearest UTC day would silently
// show them somebody else's numbers. `_5m` divides every real-world offset,
// `_1h` divides the whole-hour ones that most viewers have, and `_1d` serves
// reporting and SLO windows, which are UTC-aligned by definition. The read path
// picks the coarsest grain whose bucket divides the requested alignment.
//
// **PK `(org_id, monitor_tag, region_id, bucket_start)`, in that order.** The
// dominant query is `monitor_tag IN (...) AND region_id = ? AND bucket_start
// BETWEEN ...` inside one org, and this prefix turns it into N index range
// scans. `org_id` is *in* the key here, unlike `monitoring_data` where it is a
// plain column: these tables are new and empty, so the extra key column costs
// nothing to add and nothing to backfill.
//
// **One DDL string for all three dialects.** The alternative - knex's schema
// builder for SQLite and MySQL, raw SQL for the partitioned Postgres tables -
// is two definitions of the same thing that can drift apart without anything
// noticing. The types below are spelled so all three accept them.

const TABLES = ["monitor_rollup_5m", "monitor_rollup_1h", "monitor_rollup_1d"] as const;

/**
 * How far each partitioned table is pre-created in each direction.
 *
 * Running out is worse than it looks: rows for an uncovered period land in the
 * DEFAULT partition, and Postgres then refuses to attach a real partition for
 * that range until the default is scanned and found clear of them.
 */
const PERIODS_AROUND = 3;

function isPg(knex: Knex): boolean {
  return knex.client.config.client === "pg";
}

function isMysql(knex: Knex): boolean {
  const client = knex.client.config.client;
  return client === "mysql" || client === "mysql2";
}

/**
 * Whether a named index exists.
 *
 * Asked rather than attempted, and not left to `CREATE INDEX IF NOT EXISTS`:
 * Postgres and SQLite accept that spelling and **MySQL does not**, so the
 * shortcut would work on two dialects and fail the migration outright on the
 * third. Asking first is also the rule on Postgres for a different reason - a
 * failed statement aborts the whole transaction, so every later statement dies
 * with "current transaction is aborted" whatever a catch block does.
 */
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

/**
 * The column list, identical on every dialect.
 *
 * `bucket_start` and the other timestamps are `integer`, matching
 * `monitoring_data.timestamp`, and deliberately not `bigint`. The node-postgres
 * driver hands back a `bigint` as a *string* to avoid losing precision, so a
 * `bigint` here would mean every arithmetic comparison in the read path silently
 * became string concatenation or a NaN. 2038 is a problem this schema already
 * has on the table these roll up from; solving it in one table and not the other
 * would be worse than solving it in neither.
 */
function columnsSql(): string {
  return `
    org_id integer NOT NULL,
    monitor_tag varchar(255) NOT NULL,
    region_id integer NOT NULL,
    bucket_start integer NOT NULL,

    -- What the samples said.
    --
    -- count_total and count_no_data are separate on purpose. A bucket whose
    -- count_total is below the samples the grain expects is how the read path
    -- finally tells "down and recording nothing" apart from "this monitor did
    -- not exist yet" - a distinction fillMissingUptimeData cannot make today,
    -- because it fabricates zero-count days indistinguishable from real gaps.
    count_total integer NOT NULL DEFAULT 0,
    count_up integer NOT NULL DEFAULT 0,
    count_down integer NOT NULL DEFAULT 0,
    count_degraded integer NOT NULL DEFAULT 0,
    count_maintenance integer NOT NULL DEFAULT 0,
    count_no_data integer NOT NULL DEFAULT 0,

    -- The same counts with planned maintenance taken out, derived from
    -- maintenance *events* rather than from the sample's own type. Those are
    -- different questions: a sample can be typed MAINTENANCE without a
    -- maintenance window existing, and a window can cover samples that were
    -- never retyped. An SLA is written about the window.
    count_in_maint_window integer NOT NULL DEFAULT 0,
    count_total_excl_maint integer NOT NULL DEFAULT 0,
    count_up_excl_maint integer NOT NULL DEFAULT 0,
    count_down_excl_maint integer NOT NULL DEFAULT 0,
    count_degraded_excl_maint integer NOT NULL DEFAULT 0,

    -- Provenance, so a report can explain its own numbers. count_overlay is
    -- rows an operator wrote (an incident or maintenance overlay, a backfill);
    -- count_observed is rows a check actually produced. A month that is 90%
    -- overlay is a month whose uptime figure means something different.
    count_observed integer NOT NULL DEFAULT 0,
    count_overlay integer NOT NULL DEFAULT 0,

    -- Latency. The sum and count are kept rather than a mean, because a mean
    -- cannot be re-averaged across buckets of different sizes without weights -
    -- which is the bug UptimeCalculator has today.
    latency_count integer NOT NULL DEFAULT 0,
    latency_sum double precision NOT NULL DEFAULT 0,
    latency_min double precision,
    latency_max double precision,

    -- Materialized so the common single-bucket read never parses JSON. They are
    -- derived from the histogram and are NOT authoritative: anything spanning
    -- more than one bucket must merge the histograms and re-derive, because
    -- percentiles do not average.
    latency_p50 double precision,
    latency_p90 double precision,
    latency_p95 double precision,
    latency_p99 double precision,

    -- Sparse JSON, bucket index to count. See services/latencyHistogram.ts.
    latency_histogram text,

    -- first_ts and last_ts are the real extent of the samples inside the
    -- bucket, which is not the same as the bucket's own bounds and is what
    -- tells a partial bucket from a full one.
    first_ts integer,
    last_ts integer,
    computed_at integer NOT NULL,

    -- Bumped when the meaning of a column changes, so a recompute can be
    -- targeted at stale rows instead of at the whole table.
    rollup_version integer NOT NULL DEFAULT 1,

    PRIMARY KEY (org_id, monitor_tag, region_id, bucket_start)
  `;
}

function monthStart(ts: number): number {
  const d = new Date(ts * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}
function monthEnd(ts: number): number {
  const d = new Date(ts * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
}
function yearStart(ts: number): number {
  return Math.floor(Date.UTC(new Date(ts * 1000).getUTCFullYear(), 0, 1) / 1000);
}
function yearEnd(ts: number): number {
  return Math.floor(Date.UTC(new Date(ts * 1000).getUTCFullYear() + 1, 0, 1) / 1000);
}

/**
 * The partitions to create around `nowTs`, and their names.
 *
 * Mirrors `partitionsAround` in `src/lib/server/db/partitions.ts`. Copied rather
 * than imported: a migration has to keep working against a checkout of `src/`
 * from any later point in time, so it stays self-contained. The daily scheduler
 * keeps creating these afterwards; this only covers the window from deploy until
 * that first runs.
 */
function partitionsAround(table: string, grain: "month" | "year", nowTs: number) {
  const start = grain === "month" ? monthStart : yearStart;
  const end = grain === "month" ? monthEnd : yearEnd;

  let cursor = start(nowTs);
  for (let i = 0; i < PERIODS_AROUND; i++) cursor = start(cursor - 1);

  const out: Array<{ name: string; lo: number; hi: number }> = [];
  for (let i = 0; i < PERIODS_AROUND * 2 + 1; i++) {
    const lo = cursor;
    const hi = end(cursor);
    const d = new Date(lo * 1000);
    const suffix =
      grain === "month"
        ? `y${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, "0")}`
        : `y${d.getUTCFullYear()}`;
    out.push({ name: `${table}_${suffix}`, lo, hi });
    cursor = hi;
  }
  return out;
}

/** Postgres allows no bind parameters in DDL, so bounds go in as literal text. */
function lit(ts: number): string {
  if (!Number.isSafeInteger(ts)) throw new Error(`Refusing to build a partition bound from ${ts}`);
  return String(ts);
}

export async function up(knex: Knex): Promise<void> {
  const pg = isPg(knex);

  // `_5m` monthly and `_1h` yearly; `_1d` stays a plain table because a decade
  // of daily rollups for a thousand monitors is a few million rows, which needs
  // no partitioning to stay fast. Born partitioned rather than converted later,
  // which is free only because these tables are empty right now.
  const partitionGrain: Record<string, "month" | "year" | null> = {
    monitor_rollup_5m: "month",
    monitor_rollup_1h: "year",
    monitor_rollup_1d: null,
  };

  const nowTs = Math.floor(Date.now() / 1000);

  for (const table of TABLES) {
    const grain = partitionGrain[table];
    const partitionBy = pg && grain ? ` PARTITION BY RANGE (bucket_start)` : "";
    await knex.raw(`CREATE TABLE IF NOT EXISTS ?? (${columnsSql()})${partitionBy}`, [table]);

    // Sweeps by time across every monitor: retention, reporting, and the
    // recompute pass. The primary key cannot serve those, because it leads with
    // the monitor.
    const indexName = `idx_${table}_org_bucket`;
    if (!(await hasIndex(knex, table, indexName))) {
      await knex.raw(`CREATE INDEX ?? ON ?? (org_id, bucket_start)`, [indexName, table]);
    }

    if (!pg || !grain) continue;

    // The DEFAULT partition first, so that even a completely failed maintenance
    // pass degrades to slow rather than to a write that errors.
    await knex.raw(`CREATE TABLE IF NOT EXISTS ?? PARTITION OF ?? DEFAULT`, [`${table}_default`, table]);
    for (const partition of partitionsAround(table, grain, nowTs)) {
      await knex.raw(
        `CREATE TABLE IF NOT EXISTS ?? PARTITION OF ?? FOR VALUES FROM (${lit(partition.lo)}) TO (${lit(partition.hi)})`,
        [partition.name, table],
      );
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // Dropping the parent takes its partitions with it on Postgres, so the
  // partitions do not need naming here.
  for (const table of TABLES) {
    await knex.schema.dropTableIfExists(table);
  }
}
