import db from "../db/db.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import { HOUR_SECONDS, hourStartFor } from "../db/rollupDirty.js";
import type { DirtyHour, RollupState } from "../db/repositories/rollups.js";
import type { MonitorRollupInput, RollupGrain } from "../types/db.js";
import {
  FOLD_SOURCE,
  accumulatorToRow,
  aggregateSamples,
  bucketStartFor,
  foldRollups,
  grainSeconds,
  grainsInFoldOrder,
} from "./rollupCompute.js";

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

/**
 * The grains one hour of recompute builds in memory, in fold order.
 *
 * Cut at an hour because the unit of work is an hour: every bucket that wide or
 * narrower is wholly contained by the run, so it can be folded from the grain
 * below it without re-reading anything. A coarser bucket draws on hours the run
 * never touched, which is why the day is refolded separately by `foldDays`.
 *
 * Derived, not written out. A grain added to `FOLD_SOURCE` joins the cascade
 * here on its own, and one that does not belong here - because it is coarser
 * than the unit of work - is left out of `BACKFILL_GRAINS` too, so nothing ever
 * claims to have built a grain it did not build.
 */
const RAW_PASS_GRAINS: RollupGrain[] = grainsInFoldOrder().filter((grain) => grainSeconds(grain) <= HOUR_SECONDS);

/**
 * Everything a finished raw backfill has actually written.
 *
 * The in-memory chain, plus the day that `foldDays` refolds behind it. **A grain
 * outside this set is deliberately left incomplete** rather than marked along
 * with the rest: that is what sends it to `catchUpFoldedGrain` instead of
 * leaving it flagged as built when nothing built it.
 */
const BACKFILL_GRAINS: RollupGrain[] = [...RAW_PASS_GRAINS, "1d"];

/**
 * Where the raw pass keeps its cursor before KENER-124.
 *
 * It wrote only to `1h`, so an instance interrupted mid-backfill has its
 * position recorded there and nowhere else. The raw pass now writes to every
 * grain it reads for, and still reads this one as a fallback, so an upgrade
 * resumes where it stopped instead of starting history again.
 */
const LEGACY_BACKFILL_CURSOR_GRAIN: RollupGrain = "1h";

/** Adds a count to the field of `RecomputeSummary` that reports this grain. */
function addBuckets(summary: RecomputeSummary, grain: RollupGrain, count: number): void {
  if (grain === "5m") summary.buckets5m += count;
  else if (grain === "15m") summary.buckets15m += count;
  else if (grain === "1h") summary.buckets1h += count;
  else if (grain === "1d") summary.days += count;
}

export interface RecomputeSummary {
  hours: number;
  buckets5m: number;
  buckets15m: number;
  buckets1h: number;
  days: number;
}

const emptySummary = (): RecomputeSummary => ({ hours: 0, buckets5m: 0, buckets15m: 0, buckets1h: 0, days: 0 });

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

    // The chain, walked rather than unrolled. `5m` is the only grain that reads
    // the samples; every grain after it folds from the one before.
    //
    // Folded from the accumulators that were just built, not from the rows that
    // were just written. Re-reading would open a window in which a sample landing
    // between the two reads made the hour disagree with its own five-minute
    // buckets, and that disagreement would persist until something marked the
    // hour dirty again.
    //
    // The chain is 5m -> 15m -> 1h (KENER-124). The hour folds from the quarter
    // hours rather than straight from the five-minute rows, which is four inputs
    // instead of twelve and, more importantly, keeps every grain the exact sum of
    // the one below it. Two independent folds off the five-minute rows could not
    // drift in arithmetic, but they could drift the day somebody changes one of
    // them.
    const rowsByGrain = new Map<RollupGrain, MonitorRollupInput[]>();
    for (const grain of RAW_PASS_GRAINS) {
      const source = FOLD_SOURCE[grain];
      let buckets;
      if (source === null) {
        buckets = aggregateSamples(samples, grainSeconds(grain), windows);
      } else {
        const sourceRows = rowsByGrain.get(source);
        // Unreachable while `RAW_PASS_GRAINS` is a prefix of the fold order, and
        // worth saying out loud anyway: folding from an absent source would
        // quietly write empty buckets over real ones.
        if (!sourceRows) throw new Error(`Cannot fold ${grain}: its source ${source} is not built in this pass`);
        buckets = foldRollups(sourceRows, grainSeconds(grain));
      }
      rowsByGrain.set(
        grain,
        [...buckets.entries()].map(([bucketStart, accumulator]) =>
          accumulatorToRow(
            accumulator,
            { monitor_tag: run.monitor_tag, region_id: run.region_id, bucket_start: bucketStart },
            nowTs,
          ),
        ),
      );
    }

    // **Delete then insert, in one transaction, rather than upsert.** An hour
    // whose samples were deleted produces no buckets at all, and an upsert would
    // leave the old ones in place saying the monitor was up - the one failure
    // mode where a stale rollup actively lies rather than merely lagging.
    await db.withTransaction(async () => {
      for (const grain of RAW_PASS_GRAINS) {
        await db.deleteRollups(grain, run.monitor_tag, run.region_id, run.start, run.end);
      }
      for (const [grain, rows] of rowsByGrain) {
        await db.upsertRollups(grain, rows);
      }
    });

    for (const [grain, rows] of rowsByGrain) addBuckets(summary, grain, rows.length);

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
 * Moves the watermark on every grain.
 *
 * Each grain gets the hour watermark snapped down to its own bucket, which is a
 * no-op for anything an hour divides and is the whole point for `1d`: a day is
 * only trustworthy once the hour watermark has passed its *end*, so its
 * watermark is the start of the day containing the hour watermark. Storing the
 * raw hour on all of them would claim today's partial daily bucket was sealed.
 */
async function setWatermark(regionId: number, hourWatermark: number, nowTs: number): Promise<void> {
  for (const grain of grainsInFoldOrder()) {
    const watermark = bucketStartFor(hourWatermark, grainSeconds(grain));
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
  const states = await readRegionStates(regionId);
  const incomplete = grainsInFoldOrder().filter((grain) => !states.get(grain)?.backfill_complete);

  if (incomplete.length === 0) {
    const cursor = states.get(LEGACY_BACKFILL_CURSOR_GRAIN)?.backfill_cursor_ts ?? null;
    return { done: true, cursor, chunksProcessed: 0, summary: emptySummary() };
  }

  // **Which pass this region needs, asked per grain rather than of one grain.**
  //
  // It used to ask `1h` alone, on the reasoning that every grain was built and
  // flagged together. That held until a grain was added to an instance that had
  // already finished: `1h` said complete, the region returned here immediately,
  // and the new grain sat at `backfill_complete = false` for ever while
  // `setWatermark` handed it a watermark. `rollupsUsable` therefore said no, and
  // a viewer whose timezone needed exactly that grain was sent to raw SQL -
  // slower than the grain they had been reading before the new one existed
  // (KENER-124).
  //
  // Only a grain that reads raw samples needs the raw pass. Everything else is a
  // fold from the grain below, which is both cheaper and the only thing that can
  // work at all once retention has taken the raw rows away.
  const needsRawPass = incomplete.some((grain) => FOLD_SOURCE[grain] === null);
  if (!needsRawPass) {
    const grain = incomplete.find((candidate) => {
      const source = FOLD_SOURCE[candidate];
      return source !== null && states.get(source)?.backfill_complete;
    });
    // Incomplete, but nothing to fold it from yet. The grain below is itself
    // mid-catch-up and this region gets it on a later tick; reporting done would
    // flip the flag on a grain that is still empty.
    if (!grain) return { done: false, cursor: null, chunksProcessed: 0, summary: emptySummary() };
    return await catchUpFoldedGrain(grain, regionId, nowTs, chunks);
  }

  // The cursor still lives on `1h` for an instance that was interrupted before
  // KENER-124, and is written to every raw-pass grain from here on.
  const rawState = states.get(LEGACY_BACKFILL_CURSOR_GRAIN);
  const rawCursorGrains = RAW_PASS_GRAINS.filter((grain) => FOLD_SOURCE[grain] === null);
  const storedCursor =
    rawCursorGrains
      .map((grain) => states.get(grain)?.backfill_cursor_ts)
      .find((value) => value !== null && value !== undefined) ??
    rawState?.backfill_cursor_ts ??
    null;

  const bounds = await db.getRawSampleBounds(regionId);
  const watermark = rawState?.watermark_ts ?? hourStartFor(nowTs - ROLLUP_LAG_SECONDS);

  if (!bounds) {
    // Nothing to backfill. Complete rather than pending: an install with no
    // history has no incomplete history, and leaving the flag false would keep
    // the read path on raw SQL forever on a brand new instance.
    await markBackfillComplete(regionId, nowTs);
    return { done: true, cursor: null, chunksProcessed: 0, summary: emptySummary() };
  }

  let cursor = storedCursor ?? hourStartFor(bounds.lo);
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
    summary.buckets15m += chunkSummary.buckets15m;
    summary.buckets1h += chunkSummary.buckets1h;
    summary.days += chunkSummary.days;

    cursor = chunkEnd;
    chunksProcessed++;
    // Advanced only after the chunk is written, so a crash repeats one day
    // rather than skipping one. Written to `1h` as well as to the raw grains, so
    // a downgrade to the previous build still finds its place.
    for (const grain of [...rawCursorGrains, LEGACY_BACKFILL_CURSOR_GRAIN]) {
      await db.upsertRollupState(grain, regionId, { backfill_cursor_ts: cursor }, nowTs);
    }
  }

  const done = cursor >= watermark;
  if (done) await markBackfillComplete(regionId, nowTs);
  return { done, cursor, chunksProcessed, summary };
}

/**
 * Number of source rows a fold chunk aims to read, matching the raw pass.
 *
 * A raw chunk is a day of one monitor's samples, about 1,440 rows at a
 * one-minute check. That number is what the backfill's rate limiting was sized
 * against, so a fold that reads the same many rows puts the same pressure on the
 * five shared worker connections.
 */
const FOLD_CHUNK_SOURCE_ROWS = 1440;

/**
 * Hours per fold chunk, sized from the source grain.
 *
 * A day of five-minute buckets is 288 rows, a fifth of what a raw chunk reads,
 * so folding a day per tick would do a fifth of the work for the same overhead
 * and take five times as many ticks to walk the same history. Deriving the span
 * from the source width instead keeps the row budget constant: five days when
 * folding from `5m`, sixty when folding from `1h`.
 */
function foldChunkHours(source: RollupGrain): number {
  const rowsPerDay = DAY_SECONDS / grainSeconds(source);
  return Math.max(1, Math.floor(FOLD_CHUNK_SOURCE_ROWS / rowsPerDay)) * 24;
}

/**
 * Builds a grain from the grain below it, for history the raw pass already did.
 *
 * **The upgrade path for a grain added after an instance has been running.** The
 * raw pass cannot do this job: retention keeps raw for ninety days by default
 * and the five-minute grain for four hundred, so re-reading samples would build
 * the new grain over the last ninety days, mark it complete, and leave the three
 * hundred and ten days behind that silently empty - a read that returns "no
 * data" for history the instance still holds. Folding from the source grain
 * reconstructs exactly the span that source covers, which is precisely the span
 * the viewer could already be shown.
 *
 * Chunked, resumable and rate limited on the same terms as the raw backfill: the
 * cursor is a column on this grain's own state row, advanced only after a chunk
 * is written, so an interrupted run repeats at most one chunk.
 */
export async function catchUpFoldedGrain(
  grain: RollupGrain,
  regionId: number,
  nowTs: number,
  chunks = 1,
): Promise<BackfillProgress> {
  const source = FOLD_SOURCE[grain];
  if (source === null) throw new Error(`${grain} is built from raw samples and cannot be folded from another grain`);

  const state = await db.getRollupState(grain, regionId);
  if (state?.backfill_complete) {
    return { done: true, cursor: state.backfill_cursor_ts, chunksProcessed: 0, summary: emptySummary() };
  }

  // No watermark means the forward pass has not run for this region yet, so
  // there is no sealed boundary to fold up to. Its first tick plants one.
  if (!state || state.watermark_ts === null) {
    return { done: false, cursor: state?.backfill_cursor_ts ?? null, chunksProcessed: 0, summary: emptySummary() };
  }

  const width = grainSeconds(grain);

  // **Snapped to this grain's own grid at both ends.** A chunk boundary falling
  // inside a bucket would write that bucket from part of its sources and then
  // never revisit it, because the next chunk starts past it - the one way a fold
  // leaves a number that is wrong rather than merely missing.
  const end = bucketStartFor(state.watermark_ts, width);

  const bounds = await db.getRollupBounds(source, regionId);
  if (!bounds) {
    // Nothing to fold from, so nothing is outstanding. Same reasoning as an
    // install with no history: leaving the flag false would hold the read path
    // on raw SQL for ever over an empty source.
    await db.upsertRollupState(grain, regionId, { backfill_complete: true, backfill_completed_at: nowTs }, nowTs);
    return { done: true, cursor: null, chunksProcessed: 0, summary: emptySummary() };
  }

  if (state.backfill_started_at === null) {
    await db.upsertRollupState(grain, regionId, { backfill_started_at: nowTs }, nowTs);
  }

  const chunkSpan = foldChunkHours(source) * HOUR_SECONDS;
  let cursor = state.backfill_cursor_ts ?? bucketStartFor(bounds.lo, width);
  const summary = emptySummary();
  let chunksProcessed = 0;

  for (let chunk = 0; chunk < chunks && cursor < end; chunk++) {
    const chunkStart = cursor;
    const chunkEnd = Math.min(chunkStart + chunkSpan, end);
    const tags = await db.getTagsWithRollups(source, regionId, chunkStart, chunkEnd);

    // One monitor at a time, because `foldRollups` buckets by timestamp alone
    // and would merge two monitors into one bucket if handed both at once.
    for (const monitor_tag of tags) {
      const sourceRows = await db.getRollups(source, [monitor_tag], regionId, chunkStart, chunkEnd);
      const folded = foldRollups(sourceRows, width);
      const rows = [...folded.entries()].map(([bucketStart, accumulator]) =>
        accumulatorToRow(accumulator, { monitor_tag, region_id: regionId, bucket_start: bucketStart }, nowTs),
      );

      // Delete then insert, for the same reason the raw pass does: a window
      // whose source rows have gone must end up with no buckets, not with the
      // old ones still claiming the monitor was up.
      await db.withTransaction(async () => {
        await db.deleteRollups(grain, monitor_tag, regionId, chunkStart, chunkEnd);
        await db.upsertRollups(grain, rows);
      });
      addBuckets(summary, grain, rows.length);
    }

    cursor = chunkEnd;
    chunksProcessed++;
    await db.upsertRollupState(grain, regionId, { backfill_cursor_ts: cursor }, nowTs);
  }

  const done = cursor >= end;
  if (done) {
    await db.upsertRollupState(grain, regionId, { backfill_complete: true, backfill_completed_at: nowTs }, nowTs);
  }
  return { done, cursor, chunksProcessed, summary };
}

/** Every grain's state row for one region, in one query rather than one each. */
async function readRegionStates(regionId: number): Promise<Map<RollupGrain, RollupState>> {
  const states = await db.getAllRollupStates();
  const byGrain = new Map<RollupGrain, RollupState>();
  for (const state of states) {
    if (Number(state.region_id) === regionId) byGrain.set(state.grain as RollupGrain, state);
  }
  return byGrain;
}

export interface RegionBackfillStatus {
  /** True only when every grain has been built, not just the hourly one. */
  complete: boolean;
  /** How far the least-progressed incomplete grain has got, null if none has started. */
  cursor: number | null;
}

/**
 * How far along a region's backfill is, across all grains.
 *
 * The scheduler's ordering question. It asks for the *least* progressed grain so
 * that a region carrying a grain that has not started sorts ahead of one part
 * way through, which is the same fairness rule `pickBackfillRegion` applies
 * between regions.
 */
export async function getRegionBackfillStatus(regionId: number): Promise<RegionBackfillStatus> {
  const states = await readRegionStates(regionId);
  const incomplete = grainsInFoldOrder().filter((grain) => !states.get(grain)?.backfill_complete);
  if (incomplete.length === 0) return { complete: true, cursor: null };

  let cursor: number | null = null;
  for (const grain of incomplete) {
    const value = states.get(grain)?.backfill_cursor_ts;
    // Never started, which sorts furthest behind. Returning immediately rather
    // than folding null into a minimum keeps that meaning explicit.
    if (value === null || value === undefined) return { complete: false, cursor: null };
    cursor = cursor === null ? value : Math.min(cursor, value);
  }
  return { complete: false, cursor };
}

/**
 * Flags the grains the raw pass built, and only those.
 *
 * The list used to be written out here, which is how KENER-124 shipped broken on
 * upgrade in the other direction: a grain missing from a hand-written list is a
 * grain that never gets flagged, and a grain wrongly present is one flagged as
 * built when nothing built it. `BACKFILL_GRAINS` is derived from the fold chain
 * so neither is possible.
 */
async function markBackfillComplete(regionId: number, nowTs: number): Promise<void> {
  for (const grain of BACKFILL_GRAINS) {
    await db.upsertRollupState(grain, regionId, { backfill_complete: true, backfill_completed_at: nowTs }, nowTs);
  }
}

/** Whether the read path may trust the rollups for a region. The kill switch. */
export async function rollupsAreTrustworthy(grain: RollupGrain, regionId: number = MERGED_REGION_ID): Promise<boolean> {
  const state = await db.getRollupState(grain, regionId);
  return !!state?.backfill_complete && state.watermark_ts !== null;
}
