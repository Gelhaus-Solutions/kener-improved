import type { Knex } from "knex";
import { dialectOf } from "./capabilities.js";

/**
 * Declarative partitioning, for `monitoring_data` and the rollup grains.
 *
 * **Postgres only.** SQLite and MySQL get plain tables and range-delete
 * retention: correct, slower to prune, and per the tiered database rule.
 *
 * Two different histories meet here, and the difference matters when reading
 * this file:
 *
 *   - `monitoring_data` (B1a) is **converted**, by an operator, once, with
 *     `npm run pg:partition-monitoring-data`. It cannot be a migration: knex
 *     wraps a migration in one transaction, and copying a multi-GB table takes
 *     long enough that the container healthcheck kills the process mid-copy,
 *     after which every boot restarts the copy forever.
 *   - The rollup tables (F6a) are **born partitioned** by their migration, which
 *     is free because they are empty at that moment.
 *
 * Either way this module only knows how to name periods, ask whether a table is
 * partitioned, and create the ones that do not exist yet. It converts nothing.
 *
 * **The payoff is retention.** Deleting a day of samples from an ordinary table
 * leaves dead tuples that autovacuum reaches days later - the reason
 * `20260831120000_monitoring_data_autovacuum.ts` exists at all. Dropping a
 * partition is a catalogue update: instant, and it leaves nothing to vacuum.
 */

export type PartitionGrain = "month" | "year";

/**
 * Every table that may be partitioned, and at what grain.
 *
 * `monitor_rollup_1d` is deliberately absent: a decade of daily rollups for a
 * thousand monitors is a few million rows, which needs no partitioning to stay
 * fast, and an unpartitioned table is one fewer thing to keep supplied.
 */
export const PARTITIONED_TABLES: ReadonlyArray<{ table: string; grain: PartitionGrain }> = [
  { table: "monitoring_data", grain: "month" },
  { table: "monitor_rollup_5m", grain: "month" },
  { table: "monitor_rollup_1h", grain: "year" },
];

/**
 * How far each table is pre-created in each direction.
 *
 * Backwards as well as forwards, because a backfilled incident overlay and a
 * rollup recompute both write into the past.
 *
 * Three rather than one, because the cost of a spare empty partition is a
 * catalogue row and the cost of running out is worse than it looks: rows for an
 * uncovered period land in the DEFAULT partition, and Postgres then refuses to
 * attach a real partition for that range until the default is scanned and found
 * clear of them. Running out is recoverable, but only by moving rows.
 */
export const PERIODS_AROUND = 3;

export const defaultPartitionName = (table: string) => `${table}_default`;

/**
 * The UTC bounds of the period containing `ts`, and its name suffix.
 *
 * `Date.UTC` rather than the `new Date(y, m, d, ...)` component constructor.
 * That constructor reads the *local* zone and is only correct in the scheduler
 * process because `startup.ts` forces `TZ=UTC` before anything else loads -
 * which the `vite dev` web process never does. Calendar boundaries are the one
 * place in the data layer where integer arithmetic will not do, since months and
 * years are not a fixed number of seconds, so the constructor has to be the
 * explicitly-UTC one.
 */
export function periodBounds(ts: number, grain: PartitionGrain): { start: number; end: number; suffix: string } {
  const d = new Date(ts * 1000);
  const year = d.getUTCFullYear();
  if (grain === "year") {
    return {
      start: Math.floor(Date.UTC(year, 0, 1) / 1000),
      end: Math.floor(Date.UTC(year + 1, 0, 1) / 1000),
      suffix: `y${year}`,
    };
  }
  const month0 = d.getUTCMonth();
  return {
    start: Math.floor(Date.UTC(year, month0, 1) / 1000),
    end: Math.floor(Date.UTC(year, month0 + 1, 1) / 1000),
    suffix: `y${year}m${String(month0 + 1).padStart(2, "0")}`,
  };
}

/** Every period touching `[from, to]`, oldest first. */
export function periodsBetween(from: number, to: number, grain: PartitionGrain): Array<{ start: number; end: number }> {
  const periods: Array<{ start: number; end: number }> = [];
  let cursor = periodBounds(from, grain);
  // `<=`: a `to` landing exactly on a period start belongs to the period that
  // begins there, so that period is the last one the loop adds.
  while (cursor.start <= to) {
    periods.push({ start: cursor.start, end: cursor.end });
    cursor = periodBounds(cursor.end, grain);
  }
  return periods;
}

/** The `PERIODS_AROUND` periods either side of `nowTs`, plus its own, oldest first. */
export function partitionsAround(
  table: string,
  grain: PartitionGrain,
  nowTs: number,
): Array<{ name: string; lo: number; hi: number }> {
  let cursor = periodBounds(nowTs, grain).start;
  // Stepping back through period starts rather than subtracting seconds, since
  // periods differ in length.
  for (let i = 0; i < PERIODS_AROUND; i++) cursor = periodBounds(cursor - 1, grain).start;

  const out: Array<{ name: string; lo: number; hi: number }> = [];
  for (let i = 0; i < PERIODS_AROUND * 2 + 1; i++) {
    const period = periodBounds(cursor, grain);
    out.push({ name: `${table}_${period.suffix}`, lo: period.start, hi: period.end });
    cursor = period.end;
  }
  return out;
}

function isPg(knex: Knex): boolean {
  return dialectOf(knex) === "postgresql";
}

/**
 * A partition bound, as SQL text.
 *
 * DDL takes no bind parameters at all in Postgres - `FOR VALUES FROM (?)` fails
 * with "there is no parameter $1" rather than doing anything useful - so these
 * have to reach the server as literals. The check is what makes that safe:
 * everything partitioned on here is a UTC-second integer, and anything else is a
 * bug rather than a value to quote. knex's `??` identifier placeholders are
 * unaffected, because those are substituted into the statement text.
 */
function boundLiteral(ts: number): string {
  if (!Number.isSafeInteger(ts)) throw new Error(`Refusing to build a partition bound from ${ts}`);
  return String(ts);
}

/**
 * Whether `table` is a partitioned parent.
 *
 * `relkind = 'p'` is the only honest test. A table that merely *has* relations
 * named after it is still an ordinary table, and asking the catalogue about the
 * relation kind is what tells the two apart.
 */
export async function isPartitioned(knex: Knex, table: string): Promise<boolean> {
  if (!isPg(knex)) return false;
  const result = await knex.raw(
    `select relkind from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relname = ? and n.nspname = current_schema()`,
    [table],
  );
  const rows = ((result as { rows?: Array<{ relkind: string }> }).rows ?? []) as Array<{ relkind: string }>;
  return rows[0]?.relkind === "p";
}

async function relationExists(knex: Knex, name: string): Promise<boolean> {
  const result = await knex.raw(
    `select 1 from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relname = ? and n.nspname = current_schema()`,
    [name],
  );
  return (((result as { rows?: unknown[] }).rows ?? []) as unknown[]).length > 0;
}

/**
 * Creates every missing partition, for every table that is partitioned.
 *
 * A no-op on an unpartitioned table and on every dialect but Postgres, so the
 * daily scheduler can call it unconditionally. Returns the partitions it
 * created, which is what makes it worth logging.
 *
 * **One table failing does not stop the others.** A stranded row in one table's
 * DEFAULT partition blocks that table's next period and nothing else; letting it
 * block the rollup grains as well would turn one recoverable problem into three.
 */
export async function ensurePartitions(knex: Knex, nowTs: number): Promise<string[]> {
  if (!isPg(knex)) return [];

  const created: string[] = [];
  for (const { table, grain } of PARTITIONED_TABLES) {
    try {
      if (!(await isPartitioned(knex, table))) continue;

      const fallback = defaultPartitionName(table);
      if (!(await relationExists(knex, fallback))) {
        await knex.raw(`CREATE TABLE ?? PARTITION OF ?? DEFAULT`, [fallback, table]);
        created.push(fallback);
      }

      for (const partition of partitionsAround(table, grain, nowTs)) {
        if (await relationExists(knex, partition.name)) continue;
        await knex.raw(
          `CREATE TABLE ?? PARTITION OF ?? FOR VALUES FROM (${boundLiteral(partition.lo)}) TO (${boundLiteral(partition.hi)})`,
          [partition.name, table],
        );
        created.push(partition.name);
      }
    } catch (error) {
      console.error(`Partition maintenance failed for ${table}:`, error);
    }
  }
  return created;
}
