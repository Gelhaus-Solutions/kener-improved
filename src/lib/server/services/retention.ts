import db from "../db/db.js";
import type { Knex } from "knex";
import type { DataRetentionPolicy } from "../../types/site.js";
import { ROLLUP_TABLES, type RollupGrain } from "../types/db.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import { ROLLUP_LAG_SECONDS } from "./rollupEngine.js";
import { dropPartition, isPartitioned, partitionsEntirelyBefore } from "../db/partitions.js";

/**
 * Per-grain retention, and the guard that keeps it from destroying history (F6c).
 *
 * **This is the item the whole data layer was built to reach.** Before it, raw
 * `monitoring_data` had to be kept for as long as the longest bar anybody wanted
 * to see, because the bar was computed by scanning it. Now the bar is served
 * from rollups, so raw can be kept for weeks while the hourly and daily grains
 * carry the years - and raw is by an enormous margin the biggest table in the
 * schema.
 *
 * **It also fixes a silent bug.** `retentionDays` defaults to 90 while a page's
 * history is configurable up to `STATUS_HISTORY_DAYS_MAX` (365). Today a
 * 365-day bar is quietly truncated at 90 with nothing said. `describeCoverage`
 * turns that into a number the admin screen can show.
 *
 * **The guard that matters more than any of it.** Raw samples are only deleted
 * once the rollups computed from them are complete and sealed past the cutoff.
 * A rollup worker that has been stuck for a week, with retention still running
 * nightly, would otherwise delete history nobody has summarised yet - and unlike
 * every other failure in this cycle, that one cannot be repaired by recomputing.
 */

/**
 * The shortest raw retention that is safe, whatever an operator types.
 *
 * The read path reads raw rows for everything above the rollup watermark, so
 * raw history shorter than the scheduler's lag would leave a hole in today's
 * bucket. Seven days rather than the two the arithmetic demands, because the
 * other consumers of raw data - the confirmation threshold's lookback, incident
 * metrics' true-outage-start walk - also reach backwards, and a week is the
 * smallest number that does not require auditing all of them.
 */
export const MIN_RAW_RETENTION_DAYS = Math.max(7, Math.ceil(ROLLUP_LAG_SECONDS / 86400) + 1);

const DAY = 86400;

/** Deleting a day at a time, so no statement ever locks a multi-million-row range. */
const DELETE_WINDOW_SECONDS = DAY;

export interface RetentionStage {
  label: string;
  table: string;
  /** Rows before this are deleted. Null means "keep forever". */
  cutoff: number | null;
  partitionsToDrop: string[];
  rowsToDelete: number;
  rowsDeleted: number;
  /** Set when the stage did nothing, and why. Always logged. */
  skipped: string | null;
}

export interface RetentionRun {
  dryRun: boolean;
  stages: RetentionStage[];
  /** Applied policy after clamping, so a caller can report what actually ran. */
  effective: Required<Omit<DataRetentionPolicy, "enabled">> & { enabled: boolean };
  clamped: string[];
}

/**
 * Applies the floor and the ordering, and says what it changed.
 *
 * Clamped rather than rejected: an operator who asks for three days of raw is
 * asking for something reasonable that happens to be unsafe, and the useful
 * response is to keep the safe minimum and tell them, not to refuse the form.
 */
export function effectivePolicy(policy: DataRetentionPolicy): {
  effective: RetentionRun["effective"];
  clamped: string[];
} {
  const clamped: string[] = [];

  let raw = Math.floor(Number(policy.retentionDays) || 90);
  if (raw < MIN_RAW_RETENTION_DAYS) {
    clamped.push(`raw retention raised from ${raw} to the ${MIN_RAW_RETENTION_DAYS}-day minimum`);
    raw = MIN_RAW_RETENTION_DAYS;
  }

  const grain = (value: number | undefined, fallback: number): number => {
    const days = value === undefined || value === null ? fallback : Math.floor(Number(value));
    return Number.isFinite(days) && days >= 0 ? days : fallback;
  };

  let fiveMinute = grain(policy.rollup5mRetentionDays, 400);
  let hourly = grain(policy.rollup1hRetentionDays, 1095);
  const daily = grain(policy.rollup1dRetentionDays, 0);

  // A grain kept for less time than the raw samples under it is pointless: the
  // read path would fall back to raw for a window the rollups had already
  // dropped, which is slower and produces the same answer.
  if (fiveMinute !== 0 && fiveMinute < raw) {
    clamped.push(`5m retention raised from ${fiveMinute} to ${raw} to match raw`);
    fiveMinute = raw;
  }
  if (hourly !== 0 && hourly < fiveMinute) {
    clamped.push(`1h retention raised from ${hourly} to ${fiveMinute} to match the 5m grain`);
    hourly = fiveMinute;
  }

  return {
    effective: {
      enabled: policy.enabled,
      retentionDays: raw,
      rollup5mRetentionDays: fiveMinute,
      rollup1hRetentionDays: hourly,
      rollup1dRetentionDays: daily,
    },
    clamped,
  };
}

export interface CoverageReport {
  /** Longest bar every viewer can be served, whatever their timezone. */
  allTimezonesDays: number;
  /** Longest bar for a whole-hour offset, which is most viewers. */
  wholeHourTimezonesDays: number;
  /** Longest bar for a UTC viewer. */
  utcDays: number;
  /** True when a page is configured to show more history than retention keeps. */
  truncated: boolean;
  longestConfiguredBarDays: number;
}

/**
 * What length of bar the current policy can actually serve, per viewer.
 *
 * Three numbers rather than one, because the answer genuinely differs by
 * timezone: a Kolkata viewer's day boundaries are 19,800 seconds past a UTC day
 * and only the 5m grain divides that, so their bar is bounded by 5m retention
 * while a UTC viewer's is bounded by the daily grain. Reporting one number would
 * mean reporting the wrong one for somebody.
 */
export function describeCoverage(
  effective: RetentionRun["effective"],
  longestConfiguredBarDays: number,
): CoverageReport {
  const forever = Number.MAX_SAFE_INTEGER;
  const asDays = (days: number) => (days === 0 ? forever : days);

  const utc = Math.max(asDays(effective.rollup1dRetentionDays), asDays(effective.rollup1hRetentionDays));
  const wholeHour = Math.max(asDays(effective.rollup1hRetentionDays), asDays(effective.rollup5mRetentionDays));
  const all = asDays(effective.rollup5mRetentionDays);

  return {
    allTimezonesDays: all === forever ? 0 : all,
    wholeHourTimezonesDays: wholeHour === forever ? 0 : wholeHour,
    utcDays: utc === forever ? 0 : utc,
    // The worst case is the one that matters: a page is truncated if *any*
    // viewer would see less than it advertises.
    truncated: all !== forever && longestConfiguredBarDays > all,
    longestConfiguredBarDays,
  };
}

/**
 * Whether the rollups have caught up far enough for raw deletion to be safe.
 *
 * Every grain must be backfilled and watermarked past the cutoff. Returning a
 * reason rather than a boolean, because this is the check whose failure has to
 * end up in a log an operator will actually read.
 */
async function rawDeletionBlockedBecause(cutoff: number): Promise<string | null> {
  for (const grain of ["5m", "1h", "1d"] as RollupGrain[]) {
    const state = await db.getRollupState(grain, MERGED_REGION_ID);
    if (!state) return `the ${grain} rollups have never run`;
    if (!state.backfill_complete) return `the ${grain} rollup backfill has not finished`;
    if (state.watermark_ts === null) return `the ${grain} rollups have no watermark`;
    if (state.watermark_ts < cutoff) {
      const behind = Math.round((cutoff - state.watermark_ts) / DAY);
      return `the ${grain} rollup watermark is ${behind} day(s) behind the retention cutoff`;
    }
  }
  return null;
}

/** The oldest timestamp in a table, or null when it is empty. */
async function oldestTimestamp(knex: Knex, table: string, column: string): Promise<number | null> {
  const row = (await knex(table).min({ lo: column }).first()) as { lo?: number | string | null } | undefined;
  if (!row || row.lo === null || row.lo === undefined) return null;
  return Number(row.lo);
}

/**
 * Deletes a table's rows before `cutoff`, dropping whole partitions where it can.
 *
 * Three things happen in order, and the order is the design:
 *
 *   1. On a partitioned Postgres table, drop every partition that lies entirely
 *      before the cutoff. Instant, and it reclaims the disk immediately - the
 *      whole reason B1a's conversion script exists.
 *   2. Delete what is left, one day at a time. The boundary partition always has
 *      a remainder, and unpartitioned tables have nothing else.
 *   3. Never a single unbounded `DELETE`: on a table with years of history that
 *      is one statement holding a lock over millions of rows, which is the
 *      failure `20260831120000_monitoring_data_autovacuum.ts` was written to
 *      survive rather than to cause.
 */
async function sweepTable(
  knex: Knex,
  table: string,
  column: string,
  cutoff: number,
  dryRun: boolean,
): Promise<{ partitionsToDrop: string[]; rowsToDelete: number; rowsDeleted: number }> {
  const partitionsToDrop = (await isPartitioned(knex, table))
    ? (await partitionsEntirelyBefore(knex, table, cutoff)).map((partition) => partition.name)
    : [];

  let rowsDeleted = 0;

  if (!dryRun) {
    for (const name of partitionsToDrop) {
      await dropPartition(knex, name);
      console.log(`Retention: dropped partition ${name}`);
    }
  }

  // The count is taken *after* the partition drops, which means it says two
  // different things in the two modes - and both are the useful one. In a dry
  // run nothing was dropped, so it is every row the stage would remove. In a
  // real run the dropped partitions are already gone, so it is the remainder
  // still to be deleted row by row, and the partitions are reported by name
  // beside it.
  const countRow = (await knex(table).where(column, "<", cutoff).count("* as c").first()) as
    | { c?: number | string }
    | undefined;
  let remaining = Number(countRow?.c ?? 0);
  const rowsToDelete = remaining;

  if (dryRun || remaining === 0) {
    return { partitionsToDrop, rowsToDelete, rowsDeleted: 0 };
  }

  let cursor = await oldestTimestamp(knex, table, column);
  while (cursor !== null && cursor < cutoff && remaining > 0) {
    const windowEnd = Math.min(cursor + DELETE_WINDOW_SECONDS, cutoff);
    const removed = await knex(table).where(column, ">=", cursor).andWhere(column, "<", windowEnd).del();
    rowsDeleted += removed;
    remaining -= removed;
    cursor = windowEnd;
  }

  return { partitionsToDrop, rowsToDelete, rowsDeleted };
}

/**
 * Runs, or describes, one organisation's retention sweep.
 *
 * `dryRun` writes nothing and is what the admin screen and the operator script
 * call. The acceptance for this item is that a dry run says exactly what a real
 * run would remove.
 */
export async function runRetention(policy: DataRetentionPolicy, nowTs: number, dryRun: boolean): Promise<RetentionRun> {
  const { effective, clamped } = effectivePolicy(policy);
  const stages: RetentionStage[] = [];
  const knex = db.knexForPartitionMaintenance();

  const rawCutoff = nowTs - effective.retentionDays * DAY;

  // ---- stage 1: raw, and only if the rollups are ahead of it ---------------
  const blocked = await rawDeletionBlockedBecause(rawCutoff);
  if (blocked) {
    // **Loudly.** Silence here means an operator discovers a stalled rollup
    // worker by noticing missing history months later.
    console.warn(`Retention: SKIPPING raw monitoring_data deletion because ${blocked}. Rollups must catch up first.`);
    stages.push({
      label: "raw",
      table: "monitoring_data",
      cutoff: rawCutoff,
      partitionsToDrop: [],
      rowsToDelete: 0,
      rowsDeleted: 0,
      skipped: blocked,
    });
  } else {
    const swept = await sweepTable(knex, "monitoring_data", "timestamp", rawCutoff, dryRun);
    stages.push({ label: "raw", table: "monitoring_data", cutoff: rawCutoff, ...swept, skipped: null });
  }

  // ---- stages 2-4: the rollup grains --------------------------------------
  const grainDays: Array<[RollupGrain, number]> = [
    ["5m", effective.rollup5mRetentionDays],
    ["1h", effective.rollup1hRetentionDays],
    ["1d", effective.rollup1dRetentionDays],
  ];
  for (const [grain, days] of grainDays) {
    const table = ROLLUP_TABLES[grain];
    if (days === 0) {
      stages.push({
        label: grain,
        table,
        cutoff: null,
        partitionsToDrop: [],
        rowsToDelete: 0,
        rowsDeleted: 0,
        skipped: "kept forever",
      });
      continue;
    }
    const cutoff = nowTs - days * DAY;
    const swept = await sweepTable(knex, table, "bucket_start", cutoff, dryRun);
    stages.push({ label: grain, table, cutoff, ...swept, skipped: null });
  }

  return { dryRun, stages, effective, clamped };
}
