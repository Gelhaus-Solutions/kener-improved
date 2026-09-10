import db from "../db/db.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import { ROLLUP_GRAIN_SECONDS, type RollupGrain } from "../types/db.js";
import { grainFits, pickGrain, rollupsUsable } from "./uptimeAggregator.js";
import {
  decodeHistogram,
  emptyHistogram,
  histogramCount,
  histogramPercentiles,
  mergeHistograms,
  recordLatency,
  type LatencyHistogram,
  type LatencyPercentiles,
} from "./latencyHistogram.js";

/**
 * Latency percentiles over a window, from the rollups (B4).
 *
 * **Why this is a separate read from the uptime one.** `getRollupBucketsAggregated`
 * groups in SQL and deliberately leaves the histogram behind, because `SUM` over
 * a JSON blob means nothing and the uptime bar does not need percentiles. A
 * percentile read has to bring histograms into the process and merge them here.
 * That is affordable for one monitor and a few dozen chart points, and it is not
 * affordable for a page of a hundred monitors - which is exactly why the two
 * reads are different functions rather than one with a flag.
 *
 * **Percentiles do not average, and this module exists to keep that true.** The
 * rollup tables materialize p50/p90/p95/p99 per bucket, and those columns are
 * correct for *that bucket and no other*. Averaging two buckets' p95 is not the
 * p95 of their union and can be arbitrarily wrong. So:
 *
 *   - when one output point is exactly one rollup bucket, the materialized
 *     columns are read straight out and no JSON is parsed at all;
 *   - when a point spans several buckets, their histograms are merged and the
 *     percentiles re-derived from the merge, which is exact up to the bucketing
 *     that already happened when the sample was recorded.
 *
 * The merge is integer addition over sparse maps, which is the entire reason
 * F6a chose a histogram over storing percentiles alone.
 */

/** One point on a latency chart. */
export interface LatencyPoint {
  ts: number;
  /** Samples behind this point. Zero means the point has no latency at all. */
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
}

export interface LatencySeries {
  points: LatencyPoint[];
  /**
   * The whole window as one figure, from every histogram merged together.
   *
   * Not derivable from `points`: the p95 of a range is not any function of the
   * per-point p95s. A caller that needs a headline number has to be given one
   * computed over the union, which is what this is.
   */
  range: LatencyPoint;
  /** Which grain answered, or "raw" when the rollups could not. */
  source: RollupGrain | "raw";
  /** Regions with latency in this window, region 0 first. */
  regions: number[];
}

export interface LatencySeriesRequest {
  monitorTag: string;
  /** Region 0 is the merged verdict; probe regions are >= 1. */
  regionId?: number;
  /** Must be aligned to the grain, or the read falls back to raw. See `snapToGrain`. */
  startTimestamp: number;
  intervalSeconds: number;
  points: number;
}

const EMPTY: LatencyPercentiles = { p50: null, p90: null, p95: null, p99: null };

function pointFrom(ts: number, stats: Accumulator, percentiles: LatencyPercentiles): LatencyPoint {
  return {
    ts,
    count: stats.count,
    avg: stats.count > 0 ? stats.sum / stats.count : null,
    min: stats.min,
    max: stats.max,
    ...percentiles,
  };
}

interface Accumulator {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
}

function emptyAccumulator(): Accumulator {
  return { count: 0, sum: 0, min: null, max: null };
}

function addTo(acc: Accumulator, count: number, sum: number, min: number | null, max: number | null): void {
  acc.count += count;
  acc.sum += sum;
  if (min !== null) acc.min = acc.min === null ? min : Math.min(acc.min, min);
  if (max !== null) acc.max = acc.max === null ? max : Math.max(acc.max, max);
}

/**
 * Rounds a range down onto the grain's grid.
 *
 * **The reason the chart needed this at all.** Its range was `now - N minutes`,
 * so its bucket edges landed wherever the current minute happened to be and
 * almost never on a 5m or 1h boundary. `pickGrain` refuses an unaligned request
 * - correctly, because a rollup bucket straddling two output buckets cannot be
 * attributed to either - so every range fell through to raw SQL, which is how a
 * 30-day chart came to pull 43,200 rows and bucket them in a nested loop.
 *
 * Snapping moves an edge by less than one grain and has a second effect worth
 * having on its own: the buckets stop sliding on every refresh, so two people
 * looking at the same chart a minute apart see the same picture.
 */
export function snapToGrain(startTimestamp: number, intervalSeconds: number): number {
  const grain = pickGrain(startTimestamp, intervalSeconds);
  const width = ROLLUP_GRAIN_SECONDS[grain];
  // Snap to the interval as well as the grain, so the points stay a whole
  // interval apart and the first one still starts on a grid line.
  const step = Math.max(width, intervalSeconds);
  return Math.floor(startTimestamp / step) * step;
}

/**
 * The series for one monitor and region.
 *
 * Returns `source: "raw"` when the rollups cannot serve the request - not
 * backfilled, or an alignment no grain divides - having computed the same
 * answer from raw samples. A caller never has to know which happened, and never
 * gets a snapped answer presented as an exact one.
 */
export async function readLatencySeries(request: LatencySeriesRequest): Promise<LatencySeries> {
  const { monitorTag, startTimestamp, intervalSeconds, points } = request;
  const regionId = request.regionId ?? MERGED_REGION_ID;
  const endTimestamp = startTimestamp + points * intervalSeconds;

  const grain = pickGrain(startTimestamp, intervalSeconds);

  // Every region has rollups now (F6d). This used to require
  // `regionId === MERGED_REGION_ID`, because the scheduler passed that constant
  // to the watermark and the backfill alike and the rollup tables held region 0
  // and nothing else - so a probe region had to be served from raw samples. The
  // scheduler now advances a watermark per region, and `rollupsUsable` is asked
  // about *this* region, so a probe that has finished backfilling is served from
  // its own buckets like any other.
  //
  // Asking per region rather than trusting region 0 is the load-bearing part: a
  // probe added yesterday has no history yet, and serving its empty buckets as
  // though they were authoritative would report an outage that never happened.
  const canUseRollups = grainFits(grain, startTimestamp, intervalSeconds) && (await rollupsUsable(grain, regionId));

  // Still discovered from the samples rather than from the rollup tables. The
  // rollups only reach as far as the watermark, so a region that started
  // reporting an hour ago has samples and no buckets - and "which regions
  // reported?" has to include it, or the UI offers no way to look at the region
  // whose data is newest. The DISTINCT is served by the covering index.
  const regions = await db.getLatencyRegions(monitorTag, startTimestamp, endTimestamp);

  if (!canUseRollups) {
    return { ...(await readFromRaw(monitorTag, regionId, startTimestamp, intervalSeconds, points)), regions };
  }

  const state = await db.getRollupState(grain, regionId);
  const watermark = state?.watermark_ts ?? 0;
  const sealedEnd = Math.min(endTimestamp, watermark);

  const stats: Accumulator[] = Array.from({ length: points }, emptyAccumulator);
  const histograms: Array<LatencyHistogram | null> = new Array(points).fill(null);
  // Set only while every point in the series is exactly one rollup bucket, which
  // is when the materialized columns are usable verbatim.
  const materialized: Array<LatencyPercentiles | null> = new Array(points).fill(null);
  const oneBucketPerPoint = intervalSeconds === ROLLUP_GRAIN_SECONDS[grain];

  if (sealedEnd > startTimestamp) {
    const rows = await db.getRollupLatencyBuckets(grain, monitorTag, regionId, startTimestamp, sealedEnd);
    for (const row of rows) {
      const index = Math.floor((row.bucket_start - startTimestamp) / intervalSeconds);
      if (index < 0 || index >= points) continue;
      addTo(stats[index], row.latency_count, row.latency_sum, row.latency_min, row.latency_max);

      if (oneBucketPerPoint) {
        // Exactly this bucket's own percentiles. No JSON is touched.
        materialized[index] = {
          p50: row.latency_p50,
          p90: row.latency_p90,
          p95: row.latency_p95,
          p99: row.latency_p99,
        };
        continue;
      }
      const decoded = decodeHistogram(row.latency_histogram);
      const existing = histograms[index];
      histograms[index] = existing ? mergeHistograms(existing, decoded) : decoded;
    }
  }

  // ---- the live tail ------------------------------------------------------
  //
  // Rollups stop at the watermark because the scheduler lags deliberately, so
  // the newest minutes are only in `monitoring_data`. A chart whose right-hand
  // edge is "now" is mostly tail, so this is the common case rather than an edge.
  if (endTimestamp > watermark) {
    const tailFrom = Math.max(startTimestamp, watermark);
    const samples = await db.getRawSamples(monitorTag, regionId, tailFrom, endTimestamp);
    for (const sample of samples) {
      if (sample.latency === null || sample.latency === undefined) continue;
      const index = Math.floor((sample.timestamp - startTimestamp) / intervalSeconds);
      if (index < 0 || index >= points) continue;
      addTo(stats[index], 1, sample.latency, sample.latency, sample.latency);
      // A point that reaches into the tail can no longer be answered from a
      // materialized column: the column describes the sealed bucket alone.
      materialized[index] = null;
      const histogram = histograms[index] ?? emptyHistogram();
      recordLatency(histogram, sample.latency);
      histograms[index] = histogram;
    }
  }

  const rangeHistogram = mergeHistograms(...histograms);
  const rangeStats = emptyAccumulator();

  const series: LatencyPoint[] = [];
  for (let i = 0; i < points; i++) {
    const ts = startTimestamp + i * intervalSeconds;
    const histogram = histograms[i];
    const percentiles = materialized[i] ?? (histogram ? histogramPercentiles(histogram) : EMPTY);
    series.push(pointFrom(ts, stats[i], percentiles));
    addTo(rangeStats, stats[i].count, stats[i].sum, stats[i].min, stats[i].max);
  }

  // The range figure comes from the merged histogram whenever there is one. In
  // the one-bucket-per-point case no histograms were decoded, so it is fetched
  // deliberately rather than faked from the per-point columns, which would be
  // the exact averaging mistake this module exists to prevent.
  const rangePercentiles =
    histogramCount(rangeHistogram) > 0
      ? histogramPercentiles(rangeHistogram)
      : await rangePercentilesFromHistograms(grain, monitorTag, regionId, startTimestamp, sealedEnd);

  return {
    points: series,
    range: pointFrom(startTimestamp, rangeStats, rangePercentiles),
    source: grain,
    regions,
  };
}

/**
 * The range percentiles when the per-point path never decoded a histogram.
 *
 * One extra query, and only in the one-bucket-per-point case. The alternative is
 * to decode every histogram on the common path just in case a caller wants a
 * range figure, which would give up the whole benefit of the materialized
 * columns for every reader that only wants the chart.
 */
async function rangePercentilesFromHistograms(
  grain: RollupGrain,
  monitorTag: string,
  regionId: number,
  from: number,
  to: number,
): Promise<LatencyPercentiles> {
  if (to <= from) return EMPTY;
  const rows = await db.getRollupLatencyBuckets(grain, monitorTag, regionId, from, to);
  const merged = mergeHistograms(...rows.map((row) => decodeHistogram(row.latency_histogram)));
  return histogramCount(merged) > 0 ? histogramPercentiles(merged) : EMPTY;
}

/**
 * The same answer, computed from raw samples.
 *
 * The fallback, and also the definition: this is what "correct" means for the
 * rollup path, and the B4 driver asserts the two agree over the same window.
 */
async function readFromRaw(
  monitorTag: string,
  regionId: number,
  startTimestamp: number,
  intervalSeconds: number,
  points: number,
): Promise<Omit<LatencySeries, "regions">> {
  const endTimestamp = startTimestamp + points * intervalSeconds;
  const samples = await db.getRawSamples(monitorTag, regionId, startTimestamp, endTimestamp);

  const stats: Accumulator[] = Array.from({ length: points }, emptyAccumulator);
  const histograms: LatencyHistogram[] = Array.from({ length: points }, emptyHistogram);
  const rangeStats = emptyAccumulator();
  const rangeHistogram = emptyHistogram();

  for (const sample of samples) {
    if (sample.latency === null || sample.latency === undefined) continue;
    const index = Math.floor((sample.timestamp - startTimestamp) / intervalSeconds);
    if (index < 0 || index >= points) continue;
    addTo(stats[index], 1, sample.latency, sample.latency, sample.latency);
    recordLatency(histograms[index], sample.latency);
    addTo(rangeStats, 1, sample.latency, sample.latency, sample.latency);
    recordLatency(rangeHistogram, sample.latency);
  }

  return {
    points: stats.map((acc, i) =>
      pointFrom(startTimestamp + i * intervalSeconds, acc, histogramPercentiles(histograms[i])),
    ),
    range: pointFrom(startTimestamp, rangeStats, histogramPercentiles(rangeHistogram)),
    source: "raw",
  };
}
