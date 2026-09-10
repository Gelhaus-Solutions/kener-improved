import db from "../db/db.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import { ROLLUP_GRAIN_SECONDS, type RollupGrain, type TimestampStatusCount } from "../types/db.js";
import { addSample, emptyAccumulator, type RollupAccumulator } from "./rollupCompute.js";

/**
 * Serving uptime buckets from rollups instead of scanning raw samples (I9).
 *
 * **The query being replaced.** `getStatusCountsByIntervalGroupedByMonitor` is
 * raw SQL over `monitoring_data` for up to a hundred tags across ninety days. At
 * one sample a minute that is 129,600 rows per monitor, about 13 million for a
 * full page, aggregated on every cold view.
 *
 * **The constraint that shapes everything: the bar is bucketed in the viewer's
 * timezone.** `endOfDayTodayAtTz` flows from the browser into the request, so
 * the bucket boundaries are offset by the viewer's UTC offset - and IANA offsets
 * include `:30` and `:45`. Kolkata is +05:30, so its day boundaries sit at
 * 19,800 seconds past a UTC day, which **no daily rollup and no hourly rollup
 * can serve**: 19800 is not a multiple of 3600. Snapping such a viewer to UTC
 * days would silently show them somebody else's numbers, off by up to half a
 * day at the edges.
 *
 * So `pickGrain` chooses the coarsest grain that *divides* the requested
 * alignment, and a half-hour offset simply reads five-minute buckets. That is
 * 288 rows a day instead of 1,440 - a smaller win than the daily grain gives a
 * London viewer, and a correct one.
 *
 * **The sealed/live split.** Rollups are authoritative below the watermark and
 * do not exist above it, because the scheduler deliberately lags ten minutes so
 * a bucket is never sealed while its minutes can still be rewritten. So a read
 * takes rollups for `[start, watermark)` and raw rows for `[watermark, end)`,
 * and only the final bucket ever spans both.
 */

/** The grains this can read from, coarsest first. */
const GRAINS_COARSEST_FIRST: RollupGrain[] = ["1d", "1h", "5m"];

/**
 * The coarsest grain whose bucket divides both the interval and its alignment.
 *
 * Both conditions matter and for different reasons. The interval must be
 * divisible or a rollup bucket would straddle two output buckets and its counts
 * could not be attributed to either. The *alignment* must be divisible or the
 * output buckets are offset from the rollup grid, which is the Kolkata case:
 * every daily bucket would draw 5.5 hours of its counts from the wrong day.
 */
export function pickGrain(startTimestamp: number, intervalSeconds: number): RollupGrain {
  const offset = ((startTimestamp % 86400) + 86400) % 86400;
  for (const grain of GRAINS_COARSEST_FIRST) {
    const width = ROLLUP_GRAIN_SECONDS[grain];
    if (intervalSeconds % width === 0 && offset % width === 0) return grain;
  }
  // Finest available. An interval or offset that not even five minutes divides
  // cannot be served from rollups at all; `readUptimeBuckets` checks for that
  // and falls back to raw SQL rather than returning a snapped answer.
  return "5m";
}

/** Whether `pickGrain`'s answer can actually serve this request exactly. */
export function grainFits(grain: RollupGrain, startTimestamp: number, intervalSeconds: number): boolean {
  const width = ROLLUP_GRAIN_SECONDS[grain];
  const offset = ((startTimestamp % 86400) + 86400) % 86400;
  return intervalSeconds % width === 0 && offset % width === 0;
}

/**
 * The `TimestampStatusCount` shape the rest of the product already speaks.
 *
 * Emitting the existing shape is what lets `UptimeCalculator`,
 * `fillMissingUptimeData` and `buildMonitorBarResponseFromRawData` stay exactly
 * as they are: the change is where the numbers come from, not what they are.
 *
 * **`avgLatency` is now `latency_sum / latency_count`** - the true mean of the
 * samples in the bucket. The SQL it replaces computed `AVG(latency)` over
 * *every* row, including incident and maintenance overlay rows whose latency is
 * whatever an operator typed or a generator produced. Latency figures will shift
 * on monitors that have overlay history, and the new number is the honest one.
 */
export function toTimestampStatusCount(accumulator: RollupAccumulator, ts: number): TimestampStatusCount {
  return {
    ts,
    countOfUp: accumulator.count_up,
    countOfDown: accumulator.count_down,
    countOfDegraded: accumulator.count_degraded,
    countOfMaintenance: accumulator.count_maintenance,
    avgLatency: accumulator.latency_count > 0 ? accumulator.latency_sum / accumulator.latency_count : 0,
    maxLatency: accumulator.latency_max ?? 0,
    minLatency: accumulator.latency_min ?? 0,
  };
}

/** Which output bucket a timestamp belongs to, or -1 if it is outside the range. */
function bucketIndex(ts: number, startTimestamp: number, intervalSeconds: number, points: number): number {
  const index = Math.floor((ts - startTimestamp) / intervalSeconds);
  return index < 0 || index >= points ? -1 : index;
}

export interface UptimeBucketRequest {
  monitorTags: string[];
  startTimestamp: number;
  intervalSeconds: number;
  points: number;
}

/**
 * Whether the rollups can be believed for this region.
 *
 * Defaults to the merged region, which is what uptime always means: a bar on the
 * status page is the single authoritative verdict, never one probe's view of it.
 * F6d gave every region its own watermark and backfill flag, so latency reads
 * pass a region here; uptime deliberately does not.
 *
 * The kill switch. `backfill_complete` is false until the history behind the
 * watermark has actually been built, and it can be set back to false by hand or
 * by `npm run rollups:backfill --reset` to put the read path onto raw SQL
 * without a deploy.
 */
export async function rollupsUsable(grain: RollupGrain, regionId: number = MERGED_REGION_ID): Promise<boolean> {
  try {
    const state = await db.getRollupState(grain, regionId);
    return !!state?.backfill_complete && state.watermark_ts !== null;
  } catch {
    // A read path that throws because the rollup bookkeeping is unavailable is
    // strictly worse than one that falls back to the query it has always used.
    return false;
  }
}

/**
 * Builds the requested buckets for each tag, from rollups plus the live tail.
 *
 * Returns null when the rollups cannot serve this request - not trusted yet, or
 * an alignment no grain divides - so the caller falls back to raw SQL rather
 * than to a wrong answer.
 */
export async function readUptimeBuckets(
  request: UptimeBucketRequest,
): Promise<Map<string, TimestampStatusCount[]> | null> {
  const { monitorTags, startTimestamp, intervalSeconds, points } = request;
  if (monitorTags.length === 0) return new Map();

  const grain = pickGrain(startTimestamp, intervalSeconds);
  if (!grainFits(grain, startTimestamp, intervalSeconds)) return null;
  if (!(await rollupsUsable(grain))) return null;

  const state = await db.getRollupState(grain, MERGED_REGION_ID);
  const watermark = state?.watermark_ts ?? 0;
  const endTimestamp = startTimestamp + points * intervalSeconds;

  // One accumulator per (tag, output bucket). Allocated lazily: a hundred
  // monitors by ninety days is nine thousand, and most pages touch far fewer.
  const byTag = new Map<string, Array<RollupAccumulator | undefined>>();
  const accumulatorFor = (tag: string, index: number): RollupAccumulator => {
    let buckets = byTag.get(tag);
    if (!buckets) {
      buckets = new Array(points);
      byTag.set(tag, buckets);
    }
    let accumulator = buckets[index];
    if (!accumulator) {
      accumulator = emptyAccumulator();
      buckets[index] = accumulator;
    }
    return accumulator;
  };

  // ---- the sealed part, summed in the database ----------------------------
  //
  // **Grouped in SQL, not in JavaScript.** Folding rollup rows here is the
  // obvious implementation and it is fine at the daily grain - ninety rows per
  // monitor. At the five-minute grain a Kolkata viewer needs 25,920 rows per
  // monitor, each 28 columns wide, shipped over the wire only to be summed and
  // discarded; measured that way the "fast" path came out slower than the raw
  // SQL it replaces. The database does the grouping it was always doing, and
  // only the finished buckets travel.
  const sealedEnd = Math.min(endTimestamp, watermark);
  if (sealedEnd > startTimestamp) {
    const summed = await db.getRollupBucketsAggregated(
      grain,
      monitorTags,
      MERGED_REGION_ID,
      startTimestamp,
      intervalSeconds,
      sealedEnd,
    );
    for (const row of summed) {
      if (row.bucket_index < 0 || row.bucket_index >= points) continue;
      const accumulator = accumulatorFor(row.monitor_tag, row.bucket_index);
      accumulator.count_total += row.count_total;
      accumulator.count_up += row.count_up;
      accumulator.count_down += row.count_down;
      accumulator.count_degraded += row.count_degraded;
      accumulator.count_maintenance += row.count_maintenance;
      accumulator.latency_count += row.latency_count;
      accumulator.latency_sum += row.latency_sum;
      if (row.latency_min !== null) {
        accumulator.latency_min =
          accumulator.latency_min === null ? row.latency_min : Math.min(accumulator.latency_min, row.latency_min);
      }
      if (row.latency_max !== null) {
        accumulator.latency_max =
          accumulator.latency_max === null ? row.latency_max : Math.max(accumulator.latency_max, row.latency_max);
      }
    }
  }

  // ---- the live tail, from raw samples -----------------------------------
  //
  // At most the scheduler's lag plus one pass - about fifteen minutes of one
  // monitor's rows, straight off the primary key. This is the part that makes
  // the bar current rather than up to ten minutes stale, and it is cheap only
  // because the watermark is close behind now.
  const liveStart = Math.max(startTimestamp, watermark);
  if (endTimestamp > liveStart) {
    const windowsByTag = await db.getMaintenanceWindowsForRollup(monitorTags, liveStart, endTimestamp);
    for (const tag of monitorTags) {
      const samples = await db.getRawSamplesForRollup(tag, MERGED_REGION_ID, liveStart, endTimestamp);
      if (samples.length === 0) continue;
      const windows = windowsByTag.get(tag) ?? [];
      for (const sample of samples) {
        const index = bucketIndex(sample.timestamp, startTimestamp, intervalSeconds, points);
        if (index === -1) continue;
        addSample(accumulatorFor(tag, index), sample, windows);
      }
    }
  }

  // ---- emit ---------------------------------------------------------------
  //
  // Only buckets that actually have data, matching what the SQL returned: an
  // empty bucket has no row there either, and `fillMissingUptimeData` is what
  // turns absence into a rendered gap.
  const out = new Map<string, TimestampStatusCount[]>();
  for (const tag of monitorTags) {
    const buckets = byTag.get(tag);
    if (!buckets) {
      out.set(tag, []);
      continue;
    }
    const series: TimestampStatusCount[] = [];
    for (let index = 0; index < points; index++) {
      const accumulator = buckets[index];
      if (!accumulator || accumulator.count_total === 0) continue;
      series.push(toTimestampStatusCount(accumulator, startTimestamp + index * intervalSeconds));
    }
    out.set(tag, series);
  }
  return out;
}
