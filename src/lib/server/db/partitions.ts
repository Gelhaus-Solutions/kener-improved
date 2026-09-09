import type { Knex } from "knex";
import { dialectOf } from "./capabilities.js";

/**
 * Declarative partitioning for `monitoring_data` (B1a).
 *
 * **Postgres only, and opt-in.** A fresh install has an ordinary table and works
 * exactly as before; an operator converts it by running
 * `npm run pg:partition-monitoring-data`, once, deliberately. Nothing here
 * converts anything - this module only knows how to *name* partitions, ask
 * whether the table is partitioned, and create the months that do not exist yet.
 *
 * **Why the conversion is not a migration.** knex runs a migration inside one
 * transaction, and copying a multi-GB table takes long enough that the container
 * healthcheck kills the process mid-copy. The next boot would then start the
 * whole copy again, forever. The script is resumable and runs when an operator
 * is watching; a migration is neither.
 *
 * **The payoff is retention.** `MonitoringRepository.background` deletes roughly
 * a day of rows every night, which is what
 * `20260831120000_monitoring_data_autovacuum.ts` exists to survive: the deletes
 * leave dead tuples that autovacuum only gets to days later, and reads slow down
 * in the meantime. Against a partitioned table, dropping a month is a catalogue
 * update that reclaims the space instantly and leaves nothing to vacuum.
 */

const TABLE = "monitoring_data";

/** The safety net. Never dropped, and it should always be empty. */
export const DEFAULT_PARTITION = `${TABLE}_default`;

/**
 * How far ahead partitions are created.
 *
 * Three months rather than one, because the cost of an extra empty partition is
 * a catalogue row and the cost of running out is worse than it looks: rows for
 * an uncovered month land in the DEFAULT partition, and Postgres then refuses to
 * attach a real partition for that range until the default is scanned and found
 * clear of them. Running out is recoverable, but only by moving rows.
 */
export const MONTHS_AHEAD = 3;

/** `monitoring_data_y2026m09`, from a UTC month. */
export function partitionName(year: number, month1: number): string {
  return `${TABLE}_y${year}m${String(month1).padStart(2, "0")}`;
}

/**
 * The UTC-second bounds of the month containing `ts`, and the month after it.
 *
 * `Date.UTC` rather than the `new Date(y, m, d, ...)` component constructor.
 * That constructor reads the *local* zone, and the scheduler process only gets
 * away with using it because `startup.ts` forces `TZ=UTC` before anything else
 * loads - which the `vite dev` web process never does. Month boundaries are the
 * one place in the data layer where plain integer arithmetic will not do, since
 * months are not a fixed number of seconds, so the constructor has to be the
 * explicitly-UTC one.
 */
export function monthBounds(ts: number): { start: number; end: number; year: number; month1: number } {
  const d = new Date(ts * 1000);
  const year = d.getUTCFullYear();
  const month0 = d.getUTCMonth();
  return {
    start: Math.floor(Date.UTC(year, month0, 1, 0, 0, 0, 0) / 1000),
    end: Math.floor(Date.UTC(year, month0 + 1, 1, 0, 0, 0, 0) / 1000),
    year,
    month1: month0 + 1,
  };
}

/** Every UTC month touching `[from, to]`, oldest first. */
export function monthsBetween(from: number, to: number): Array<{ start: number; end: number }> {
  const months: Array<{ start: number; end: number }> = [];
  let cursor = monthBounds(from);
  // `<=`: a `to` landing exactly on a month start belongs to the month that
  // begins there, so that month is the last one the loop adds.
  while (cursor.start <= to) {
    months.push({ start: cursor.start, end: cursor.end });
    cursor = monthBounds(cursor.end);
  }
  return months;
}

function isPg(knex: Knex): boolean {
  return dialectOf(knex) === "postgresql";
}

/**
 * A partition bound, as SQL text.
 *
 * DDL takes no bind parameters, so these have to reach Postgres as literals.
 * The check is what makes that safe: everything this module partitions on is a
 * UTC-second integer, and anything else is a bug rather than a value to quote.
 */
function boundLiteral(ts: number): string {
  if (!Number.isSafeInteger(ts)) throw new Error(`Refusing to build a partition bound from ${ts}`);
  return String(ts);
}

/**
 * Whether `monitoring_data` is a partitioned parent.
 *
 * `relkind = 'p'` is the only honest test. A table that merely *has* partitions
 * named after it is still an ordinary table, and asking the catalogue about the
 * relation kind is what tells the two apart.
 */
export async function isMonitoringDataPartitioned(knex: Knex): Promise<boolean> {
  if (!isPg(knex)) return false;
  const result = await knex.raw(
    `select relkind from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relname = ? and n.nspname = current_schema()`,
    [TABLE],
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
 * Creates any missing monthly partition from `MONTHS_AHEAD` months back through
 * `MONTHS_AHEAD` months forward, plus the DEFAULT partition.
 *
 * Backwards as well as forwards because a conversion that has just finished, or
 * a backfilled incident overlay, can write into a month that has already passed.
 *
 * A no-op on a table that is not partitioned and on every dialect but Postgres,
 * so the daily scheduler can call it unconditionally. Returns the partitions it
 * created, which is what makes it worth logging.
 */
export async function ensureMonitoringDataPartitions(knex: Knex, nowTs: number): Promise<string[]> {
  if (!(await isMonitoringDataPartitioned(knex))) return [];

  const created: string[] = [];

  if (!(await relationExists(knex, DEFAULT_PARTITION))) {
    await knex.raw(`CREATE TABLE ?? PARTITION OF ?? DEFAULT`, [DEFAULT_PARTITION, TABLE]);
    created.push(DEFAULT_PARTITION);
  }

  const from = monthBounds(nowTs);
  // Walk back MONTHS_AHEAD months by stepping through month starts rather than
  // subtracting seconds, since months differ in length.
  let earliest = from.start;
  for (let i = 0; i < MONTHS_AHEAD; i++) earliest = monthBounds(earliest - 1).start;
  let latest = from.start;
  for (let i = 0; i < MONTHS_AHEAD; i++) latest = monthBounds(latest).end;

  for (const month of monthsBetween(earliest, latest)) {
    const { year, month1 } = monthBounds(month.start);
    const name = partitionName(year, month1);
    if (await relationExists(knex, name)) continue;
    // **The bounds are interpolated, not bound.** Postgres allows no parameters
    // in DDL at all, so `FOR VALUES FROM (?)` fails with "there is no parameter
    // $1" rather than doing anything useful. knex substitutes `??` identifiers
    // into the statement text, which is why those still work here. The two
    // interpolated values come from `monthBounds`, which returns integers from
    // `Date.UTC`, and `boundLiteral` refuses anything else.
    await knex.raw(
      `CREATE TABLE ?? PARTITION OF ?? FOR VALUES FROM (${boundLiteral(month.start)}) TO (${boundLiteral(month.end)})`,
      [name, TABLE],
    );
    created.push(name);
  }

  return created;
}
