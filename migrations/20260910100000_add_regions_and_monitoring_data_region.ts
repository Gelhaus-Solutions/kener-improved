import type { Knex } from "knex";

// B1a: `region_id` joins `monitoring_data`'s primary key, and `regions` gets a table.
//
// **Why the key and not merely a column.** The primary key is
// `(monitor_tag, timestamp)` (`20250111153517_init.ts:11`) and both write paths
// rely on it: `insertMonitoringData` and `updateMonitoringData` both say
// `.onConflict(["monitor_tag", "timestamp"]).merge(...)`. The day a second
// region reports the same minute for the same monitor, that conflict target
// matches and one sample silently overwrites the other. Nothing errors, nothing
// logs, and the row that survives is whichever landed last. So the key has to
// carry the region before any probe can exist, not after.
//
// **Why now, in one migration.** This is the largest table in the schema.
// Rewriting it once for `org_id` (`20260909100000`), again for `region_id` and
// again for partitioning is three maintenance windows to reach one shape. The
// column and the key change together here; partitioning is deliberately left to
// `npm run pg:partition-monitoring-data`, because a multi-GB table rewrite on
// container start gets killed mid-copy by the Docker healthcheck and an
// operator-run script can be resumed.
//
// **`region_id = 0` is the merged, authoritative verdict.** Probe samples land
// at `>= 1`. Every existing query in `repositories/monitoring.ts` gains exactly
// one predicate, `region_id = 0`, and its meaning never changes again. Without
// the convention, `getLatestMonitoringData`, `getLastKnownStatus`,
// `consecutivelyStatusFor` and the whole confirmation threshold start seeing N
// rows per minute the day region 2 appears, and every one of them is wrong in a
// different way.
//
// **DEPLOY NOTE: this is a maintenance-window migration on an instance with a
// large history.** Adding `region_id` is cheap - Postgres 11+ records a
// non-volatile default in the catalogue rather than rewriting the heap - but
// swapping the primary key builds a new unique index over every row under
// ACCESS EXCLUSIVE, and so does each of the two secondary indexes rebuilt
// below. knex runs a migration in a single transaction, so all of it is one
// lock held to commit. `20260909120000` already established this cost on this
// table for the same reason; this is the same window, not a new one. On SQLite
// a primary key change is a full table rebuild, which knex performs as
// create-copy-drop-rename. That is safe here only because nothing foreign-keys
// to `monitoring_data` - the cascade hazard documented at length in
// `20260909100000` needs a child table, and this table has none.

const REGIONS = "regions";
const MONITORING_DATA = "monitoring_data";

/**
 * The reserved id of the merged verdict.
 *
 * Mirrors `MERGED_REGION_ID` in `src/lib/server/db/regions.ts`. It cannot import
 * it: a migration has to keep working against a checkout of `src/` from any
 * later point in time, so it stays self-contained.
 */
const MERGED_REGION_ID = 0;

const OLD_COVERING_INDEX = "idx_monitoring_data_monitor_tag_timestamp_status_latency";
const NEW_COVERING_INDEX = "idx_monitoring_data_tag_region_ts_status_latency";
const OLD_TYPE_INDEX = "idx_monitoring_data_monitor_tag_type_timestamp";
const NEW_TYPE_INDEX = "idx_monitoring_data_tag_region_type_ts";

const OLD_PK = ["monitor_tag", "timestamp"];
const NEW_PK = ["monitor_tag", "region_id", "timestamp"];

function isPg(knex: Knex): boolean {
  return knex.client.config.client === "pg";
}

function isMysql(knex: Knex): boolean {
  const client = knex.client.config.client;
  return client === "mysql" || client === "mysql2";
}

/**
 * The columns of `table`'s primary key, in key order.
 *
 * Asked rather than attempted. The obvious way to make a key swap re-runnable is
 * to issue it and swallow the error, and on Postgres that does not work: a
 * failed statement aborts the whole transaction, so every later statement fails
 * with "current transaction is aborted" whatever the catch block does. Being
 * re-runnable on Postgres means never issuing a statement that can fail, which
 * means knowing the current shape first.
 */
async function primaryKeyColumns(knex: Knex, table: string): Promise<string[]> {
  if (isPg(knex)) {
    const result = await knex.raw(
      `select kcu.column_name as col
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
          and kcu.table_schema = tc.table_schema
        where tc.table_schema = current_schema()
          and tc.table_name = ?
          and tc.constraint_type = 'PRIMARY KEY'
        order by kcu.ordinal_position`,
      [table],
    );
    return ((result as { rows?: Array<{ col: string }> }).rows ?? []).map((r) => String(r.col));
  }

  if (isMysql(knex)) {
    const result = await knex.raw(
      `select column_name as col from information_schema.statistics
        where table_schema = database() and table_name = ? and index_name = 'PRIMARY'
        order by seq_in_index`,
      [table],
    );
    const rows = Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : [];
    return (rows as Array<Record<string, unknown>>).map((r) => String(r.col ?? r.COLUMN_NAME));
  }

  // SQLite. `PRAGMA table_info` reports each column's 1-based position in the
  // primary key, or 0 for columns outside it. The table name is a module
  // constant, so interpolating it is not a binding decision.
  const result = await knex.raw(`PRAGMA table_info(${table})`);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? [])) as Array<
    Record<string, unknown>
  >;
  return rows
    .filter((r) => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => String(r.name));
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((col, i) => col === b[i]);
}

/** Whether a named index exists on `table`. Same no-failing-statement rule as above. */
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
  // ---- 1. The regions catalogue ------------------------------------------
  //
  // `org_id` is nullable, and exactly one row uses that: id 0, the merged
  // verdict, which belongs to the instance rather than to a tenant. Probe
  // regions an org creates carry their org.
  //
  // **`code` is unique globally, not per org**, and that is a decision rather
  // than an oversight. A unique over `(org_id, code)` would be useless here:
  // `org_id` is null on the one row that matters and Postgres treats distinct
  // nulls as distinct, so the constraint would permit any number of duplicate
  // instance-wide rows - the same trap that says a nullable column has no place
  // in a UNIQUE when "no value" is a real case. Global codes also match how
  // `monitors.tag` already behaves.
  if (!(await knex.schema.hasTable(REGIONS))) {
    await knex.schema.createTable(REGIONS, (table) => {
      table.increments("id").primary();
      table.integer("org_id").nullable();
      table.string("code", 64).notNullable();
      table.string("name", 255).notNullable();
      table.text("description").nullable();
      // A region can be retired without deleting the samples that name it.
      table.boolean("is_active").notNullable().defaultTo(true);
      table.timestamp("created_at").defaultTo(knex.fn.now());
      table.timestamp("updated_at").defaultTo(knex.fn.now());

      table.unique(["code"], { indexName: "regions_code_unique" });
      table.index(["org_id"], "idx_regions_org_id");
    });
  }

  // The merged verdict, written with an explicit id. `increments` starts its
  // sequence at 1, so claiming 0 by hand neither consumes nor skips a generated
  // id and the next probe region is still 1.
  const merged = await knex(REGIONS).where("id", MERGED_REGION_ID).first();
  if (!merged) {
    await knex(REGIONS).insert({
      id: MERGED_REGION_ID,
      org_id: null,
      code: "merged",
      name: "Merged verdict",
      description:
        "The single authoritative status for a monitor at a timestamp. Everything Kener renders reads this region. Probe regions report alongside it at id >= 1 and are merged into it.",
      is_active: true,
    });
  }

  if (!(await knex.schema.hasTable(MONITORING_DATA))) return;

  // ---- 2. The column -----------------------------------------------------
  //
  // NOT NULL with a default, so every existing row becomes a region-0 row
  // without a backfill pass and without a window where the column is null.
  if (!(await knex.schema.hasColumn(MONITORING_DATA, "region_id"))) {
    await knex.schema.alterTable(MONITORING_DATA, (table) => {
      table.integer("region_id").notNullable().defaultTo(MERGED_REGION_ID);
    });
  }

  // ---- 3. Drop the old secondary indexes ---------------------------------
  //
  // Before the key swap rather than after, for two reasons. On Postgres it
  // avoids rebuilding an index that is about to be replaced. On SQLite the key
  // swap is a table rebuild that carries every surviving index across with it,
  // so dropping first means copying two fewer.
  for (const indexName of [OLD_COVERING_INDEX, OLD_TYPE_INDEX]) {
    if (await hasIndex(knex, MONITORING_DATA, indexName)) {
      await knex.schema.alterTable(MONITORING_DATA, (table) => {
        table.dropIndex([], indexName);
      });
    }
  }

  // ---- 4. The key --------------------------------------------------------
  const currentPk = await primaryKeyColumns(knex, MONITORING_DATA);
  if (!sameColumns(currentPk, NEW_PK)) {
    await knex.schema.alterTable(MONITORING_DATA, (table) => {
      // Only when there is one to drop. A table that somehow has no primary key
      // still gets the right one rather than failing on the drop.
      if (currentPk.length > 0) table.dropPrimary();
      table.primary(NEW_PK);
    });
  }

  // ---- 5. The secondary indexes, in the new shape ------------------------
  //
  // Both gain `region_id` immediately after `monitor_tag`, matching the key, so
  // the `region_id = 0` predicate every read now carries is satisfied by the
  // index prefix instead of by a filter step over every matched row.
  if (!(await hasIndex(knex, MONITORING_DATA, NEW_COVERING_INDEX))) {
    await knex.schema.alterTable(MONITORING_DATA, (table) => {
      table.index(["monitor_tag", "region_id", "timestamp", "status", "latency"], NEW_COVERING_INDEX);
    });
  }
  if (!(await hasIndex(knex, MONITORING_DATA, NEW_TYPE_INDEX))) {
    await knex.schema.alterTable(MONITORING_DATA, (table) => {
      table.index(["monitor_tag", "region_id", "type", "timestamp"], NEW_TYPE_INDEX);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(MONITORING_DATA)) {
    for (const indexName of [NEW_COVERING_INDEX, NEW_TYPE_INDEX]) {
      if (await hasIndex(knex, MONITORING_DATA, indexName)) {
        await knex.schema.alterTable(MONITORING_DATA, (table) => {
          table.dropIndex([], indexName);
        });
      }
    }

    // **Rows outside region 0 are deleted here, and that is the honest thing to
    // do.** The old key cannot hold them: two regions reporting one minute
    // collapse to one row under `(monitor_tag, timestamp)`, so restoring that
    // key with probe samples present either fails on a duplicate or silently
    // discards whichever row loses. Discarding them explicitly, before the key
    // swap, at least says so.
    if (await knex.schema.hasColumn(MONITORING_DATA, "region_id")) {
      await knex(MONITORING_DATA).where("region_id", "<>", MERGED_REGION_ID).del();
    }

    const currentPk = await primaryKeyColumns(knex, MONITORING_DATA);
    if (!sameColumns(currentPk, OLD_PK)) {
      await knex.schema.alterTable(MONITORING_DATA, (table) => {
        if (currentPk.length > 0) table.dropPrimary();
        table.primary(OLD_PK);
      });
    }

    if (await knex.schema.hasColumn(MONITORING_DATA, "region_id")) {
      await knex.schema.alterTable(MONITORING_DATA, (table) => table.dropColumn("region_id"));
    }

    if (!(await hasIndex(knex, MONITORING_DATA, OLD_COVERING_INDEX))) {
      await knex.schema.alterTable(MONITORING_DATA, (table) => {
        table.index(["monitor_tag", "timestamp", "status", "latency"], OLD_COVERING_INDEX);
      });
    }
    if (!(await hasIndex(knex, MONITORING_DATA, OLD_TYPE_INDEX))) {
      await knex.schema.alterTable(MONITORING_DATA, (table) => {
        table.index(["monitor_tag", "type", "timestamp"], OLD_TYPE_INDEX);
      });
    }
  }

  await knex.schema.dropTableIfExists(REGIONS);
}
