import db from "../db/db.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import { HOUR_SECONDS, hourStartFor } from "../db/rollupDirty.js";
import type { DirtyHour } from "../db/repositories/rollups.js";
import type { RollupGrain } from "../types/db.js";
import { accumulatorToRow, aggregateSamples, bucketStartFor, foldRollups, grainSeconds } from "./rollupCompute.js";

/**
 * Computing rollups: the forward pass, the dirty drain and the backfill (F6b).
 *
 * **All three are the same operation.** Every one of them ends up calling
 * `recomputeHours` with a list of (monitor, region, hour) units, and every unit
 * is computed by a full aggregate over its source rows. That is what makes late
 * data, a BullMQ retry, a confirmation-threshold flip and an overlay rewrite
 * indistinguishable from each other: none of them needs to know what the bucket
 * used to hold, only which hour to do again.
 *
 * **The unit of work is an hour** because that is the dirty unit; see the
 * migration for why a per-bucket set does not survive a C7 backfill.
 *
 * The cascade for one hour:
 *
 *   1. twelve 5m buckets, aggregated from raw `monitoring_data`
 *   2. one 1h bucket, folded from those twelve **in memory** - never re-read,
 *      so the two grains cannot disagree even if a sample lands between them
 *   3. the containing day, refolded from its twenty-four hourly rows, which does
 *      have to be re-read because the other twenty-three were not recomputed
 */

/**
 * How far behind `now` the forward pass stops.
 *
 * Ten minutes. `monitorResponseQueue` retries three times with exponential
 * backoff from five seconds, a slow check can take a minute, and a confirmation
 * threshold restates minutes that have already been written. Sealing a bucket
 * before all of that has settled would mean computing it from an incomplete hour
 * and never revisiting it, because nothing marks a bucket dirty for having been
 * computed too early.
 */
export const ROLLUP_LAG_SECONDS = 600;

/** Hours per backfill chunk. One day, so a chunk is one query per monitor. */
export const BACKFILL_CHUNK_HOURS = 24;

const DAY_SECONDS = 86400;

export interface RecomputeSummary {
  hours: number;
  buckets5m: number;
  buckets1h: number;
  days: number;
}

const emptySummary = (): RecomputeSummary => ({ hours: 0, buckets5m: 0, buckets1h: 0, days: 0 });

/** Consecutive hours for one monitor, so a run is one query rather than N. */
interface HourRun {
  monitor_tag: string;
  region_id: number;
  start: number;
  end: number;
}

/**
 * Groups units into contiguous runs of at most `BACKFILL_CHUNK_HOURS`.
 *
 * A run becomes one raw-sample query. Capping the length keeps a single query
 * bounded at a day of one monitor's samples - 1,440 rows - however many hours a
 * caller hands over at once.
 */
export function buildRuns(units: ReadonlyArray<DirtyHour>): HourRun[] {
  const byMonitor = new Map<string, DirtyHour[]>();
  for (const unit of units) {
    // JSON rather than a separator character: a monitor tag is user-supplied
    // text, and any delimiter picked here is one a tag could eventually hold.
    const key = JSON.stringify([unit.monitor_tag, unit.region_id]);
    const list = byMonitor.get(key) ?? [];
    list.push(unit);
    byMonitor.set(key, list);
  }

  const runs: HourRun[] = [];
  for (const list of byMonitor.values()) {
    list.sort((a, b) => a.hour_start - b.hour_start);
    let start: number | null = null;
    let previous = 0;
    let length = 0;
    for (const unit of list) {
      if (start === null) {
        start = unit.hour_start;
        length = 1;
      } else if (unit.hour_start === previous + HOUR_SECONDS && length < BACKFILL_CHUNK_HOURS) {
        length += 1;
      } else if (unit.hour_start === previous) {
        continue; // duplicate
      } else {
        runs.push({
          monitor_tag: list[0].monitor_tag,
          region_id: list[0].region_id,
          start,
          end: previous + HOUR_SECONDS,
        });
        start = unit.hour_start;
        length = 1;
      }
      previous = unit.hour_start;
    }
    if (start !== null) {
      runs.push({
        monitor_tag: list[0].monitor_tag,
        region_id: list[0].region_id,
        start,
        end: previous + HOUR_SECONDS,
      });
    }
  }
  return runs;
}

/**
 * Recomputes every hour in `units`, cascading up to the day.
 *
 * Returns what it wrote, which is the only honest way for a scheduler log to say
 * whether a pass did anything.
 */
export async function recomputeHours(units: ReadonlyArray<DirtyHour>, nowTs: number): Promise<RecomputeSummary> {
  const summary = emptySummary();
  if (units.length === 0) return summary;
  summary.hours = units.length;

  const runs = buildRuns(units);
  // A Map keyed by the JSON identity but carrying the parsed value, so nothing
  // ever has to split a composite key back apart.
  const touchedDays = new Map<string, { monitor_tag: string; region_id: number; day_start: number }>();

  for (const run of runs) {
    const samples = await db.getRawSamplesForRollup(run.monitor_tag, run.region_id, run.start, run.end);
    const windowsByTag = await db.getMaintenanceWindowsForRollup([run.monitor_tag], run.start, run.end);
    const windows = windowsByTag.get(run.monitor_tag) ?? [];

    const fine = aggregateSamples(samples, grainSeconds("5m"), windows);
    const rows5m = [...fine.entries()].map(([bucketStart, accumulator]) =>
      accumulatorToRow(
        accumulator,
        { monitor_tag: run.monitor_tag, region_id: run.region_id, bucket_start: bucketStart },
        nowTs,
      ),
    );

    // Folded from the accumulators that were just built, not from the rows that
    // were just written. Re-reading would open a window in which a sample landing
    // between the two reads made the hour disagree with its own five-minute
    // buckets, and that disagreement would persist until something marked the
    // hour dirty again.
    const coarse = foldRollups(rows5m, grainSeconds("1h"));
    const rows1h = [...coarse.entries()].map(([bucketStart, accumulator]) =>
      accumulatorToRow(
        accumulator,
        { monitor_tag: run.monitor_tag, region_id: run.region_id, bucket_start: bucketStart },
        nowTs,
      ),
    );

    // **Delete then insert, in one transaction, rather than upsert.** An hour
    // whose samples were deleted produces no buckets at all, and an upsert would
    // leave the old ones in place saying the monitor was up - the one failure
    // mode where a stale rollup actively lies rather than merely lagging.
    await db.withTransaction(async () => {
      await db.deleteRollups("5m", run.monitor_tag, run.region_id, run.start, run.end);
      await db.deleteRollups("1h", run.monitor_tag, run.region_id, run.start, run.end);
      await db.upsertRollups("5m", rows5m);
      await db.upsertRollups("1h", rows1h);
    });

    summary.buckets5m += rows5m.length;
    summary.buckets1h += rows1h.length;

    for (let hour = run.start; hour < run.end; hour += HOUR_SECONDS) {
      const dayStart = bucketStartFor(hour, DAY_SECONDS);
      touchedDays.set(JSON.stringify([run.monitor_tag, run.region_id, dayStart]), {
        monitor_tag: run.monitor_tag,
        region_id: run.region_id,
        day_start: dayStart,
      });
    }
  }

  summary.days = await foldDays([...touchedDays.values()], nowTs);
  return summary;
}

/**
 * Refolds daily buckets from their hourly rows.
 *
 * The one place that has to re-read rather than fold in memory: recomputing one
 * hour leaves the day's other twenty-three untouched, and the day is the sum of
 * all of them.
 */
export async function foldDays(
  days: ReadonlyArray<{ monitor_tag: string; region_id: number; day_start: number }>,
  nowTs: number,
): Promise<number> {
  let written = 0;
  for (const day of days) {
    const hourly = await db.getRollups(
      "1h",
      [day.monitor_tag],
      day.region_id,
      day.day_start,
      day.day_start + DAY_SECONDS,
    );
    const folded = foldRollups(hourly, DAY_SECONDS);
    const rows = [...folded.entries()].map(([bucketStart, accumulator]) =>
      accumulatorToRow(
        accumulator,
        { monitor_tag: day.monitor_tag, region_id: day.region_id, bucket_start: bucketStart },
        nowTs,
      ),
    );

    await db.withTransaction(async () => {
      await db.deleteRollups("1d", day.monitor_tag, day.region_id, day.day_start, day.day_start + DAY_SECONDS);
      await db.upsertRollups("1d", rows);
    });
    written += rows.length;
  }
  return written;
}

// ---------------------------------------------------------------------------
// The three callers.

/**
 * Drains the dirty set: the invalidations that came from history being rewritten.
 *
 * Cleared **after** the recompute. A crash between the two leaves the hour marked
 * and it is done again, which costs one repeated aggregate; clearing first would
 * lose the invalidation and leave a bucket permanently disagreeing with its
 * samples.
 */
export async function drainDirty(limit: number, nowTs: number): Promise<RecomputeSummary> {
  const hours = await db.takeDirtyHours(limit);
  if (hours.length === 0) return emptySummary();
  const summary = await recomputeHours(hours, nowTs);
  await db.clearDirtyHours(hours);
  return summary;
}

/**
 * Computes the hours that have become sealable since the last pass.
 *
 * On the very first run the watermark is planted at the current lag boundary
 * rather than at the oldest sample, so the forward pass is immediately cheap and
 * everything older becomes the backfill's job. That split is what lets the whole
 * layer ship dark: the forward pass keeps up from the moment of deploy, and the
 * history arrives behind it at whatever rate the rate limiter allows.
 */
export async function advanceWatermark(regionId: number, nowTs: number): Promise<RecomputeSummary> {
  const sealable = hourStartFor(nowTs - ROLLUP_LAG_SECONDS);
  const state = await db.getRollupState("1h", regionId);

  if (!state || state.watermark_ts === null) {
    await setWatermark(regionId, sealable, nowTs);
    return emptySummary();
  }
  if (state.watermark_ts >= sealable) return emptySummary();

  const tags = await db.getTagsWithSamples(regionId, state.watermark_ts, sealable);
  const units: DirtyHour[] = [];
  for (const monitor_tag of tags) {
    for (let hour = state.watermark_ts; hour < sealable; hour += HOUR_SECONDS) {
      units.push({ monitor_tag, region_id: regionId, hour_start: hour });
    }
  }

  const summary = await recomputeHours(units, nowTs);
  await setWatermark(regionId, sealable, nowTs);
  return summary;
}

/**
 * Moves the watermark on all three grains.
 *
 * `1d` gets a different value on purpose: a day is only trustworthy once the
 * hour watermark has passed its *end*, so its watermark is the start of the day
 * containing the hour watermark. Storing the same number on all three would
 * claim today's partial daily bucket was sealed.
 */
async function setWatermark(regionId: number, hourWatermark: number, nowTs: number): Promise<void> {
  const grains: Array<[RollupGrain, number]> = [
    ["5m", hourWatermark],
    ["1h", hourWatermark],
    ["1d", bucketStartFor(hourWatermark, DAY_SECONDS)],
  ];
  for (const [grain, watermark] of grains) {
    await db.upsertRollupState(grain, regionId, { watermark_ts: watermark }, nowTs);
  }
}

export interface BackfillProgress {
  done: boolean;
  cursor: number | null;
  chunksProcessed: number;
  summary: RecomputeSummary;
}

/**
 * Walks history oldest to newest, one day at a time.
 *
 * **Concurrency 1 and one chunk per invocation**, deliberately. The worker
 * connection pool is five connections by default and the monitor checks share
 * it; a backfill that grabbed as much as it could would starve the thing the
 * product exists to do. A day of one monitor's samples per query, one day per
 * call, and the scheduler decides how often to call.
 *
 * Resumable without a lock: the cursor is a column, advanced only after the
 * chunk is written, so an interrupted run repeats at most one day.
 */
export async function backfillChunk(regionId: number, nowTs: number, chunks = 1): Promise<BackfillProgress> {
  const state = await db.getRollupState("1h", regionId);
  if (state?.backfill_complete) {
    return { done: true, cursor: state.backfill_cursor_ts, chunksProcessed: 0, summary: emptySummary() };
  }

  const bounds = await db.getRawSampleBounds(regionId);
  const watermark = state?.watermark_ts ?? hourStartFor(nowTs - ROLLUP_LAG_SECONDS);

  if (!bounds) {
    // Nothing to backfill. Complete rather than pending: an install with no
    // history has no incomplete history, and leaving the flag false would keep
    // the read path on raw SQL forever on a brand new instance.
    await markBackfillComplete(regionId, nowTs);
    return { done: true, cursor: null, chunksProcessed: 0, summary: emptySummary() };
  }

  let cursor = state?.backfill_cursor_ts ?? hourStartFor(bounds.lo);
  const summary = emptySummary();
  let chunksProcessed = 0;

  for (let chunk = 0; chunk < chunks && cursor < watermark; chunk++) {
    const chunkEnd = Math.min(cursor + BACKFILL_CHUNK_HOURS * HOUR_SECONDS, watermark);
    const tags = await db.getTagsWithSamples(regionId, cursor, chunkEnd);

    const units: DirtyHour[] = [];
    for (const monitor_tag of tags) {
      for (let hour = cursor; hour < chunkEnd; hour += HOUR_SECONDS) {
        units.push({ monitor_tag, region_id: regionId, hour_start: hour });
      }
    }

    const chunkSummary = await recomputeHours(units, nowTs);
    summary.hours += chunkSummary.hours;
    summary.buckets5m += chunkSummary.buckets5m;
    summary.buckets1h += chunkSummary.buckets1h;
    summary.days += chunkSummary.days;

    cursor = chunkEnd;
    chunksProcessed++;
    // Advanced only after the chunk is written, so a crash repeats one day
    // rather than skipping one.
    await db.upsertRollupState("1h", regionId, { backfill_cursor_ts: cursor }, nowTs);
  }

  const done = cursor >= watermark;
  if (done) await markBackfillComplete(regionId, nowTs);
  return { done, cursor, chunksProcessed, summary };
}

async function markBackfillComplete(regionId: number, nowTs: number): Promise<void> {
  for (const grain of ["5m", "1h", "1d"] as RollupGrain[]) {
    await db.upsertRollupState(grain, regionId, { backfill_complete: true, backfill_completed_at: nowTs }, nowTs);
  }
}

/** Whether the read path may trust the rollups for a region. The kill switch. */
export async function rollupsAreTrustworthy(grain: RollupGrain, regionId: number = MERGED_REGION_ID): Promise<boolean> {
  const state = await db.getRollupState(grain, regionId);
  return !!state?.backfill_complete && state.watermark_ts !== null;
}
