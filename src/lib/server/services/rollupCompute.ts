import GC from "../../global-constants.js";
import {
  type LatencyHistogram,
  decodeHistogram,
  emptyHistogram,
  encodeHistogram,
  histogramPercentiles,
  mergeHistograms,
  recordLatency,
} from "./latencyHistogram.js";
import { ROLLUP_GRAIN_SECONDS, type MonitorRollupInput, type RollupGrain } from "../types/db.js";

/**
 * Turning samples into rollup buckets, and buckets into coarser buckets (F6b).
 *
 * Pure functions with no database in sight, so the arithmetic that every uptime
 * number in the product will eventually rest on can be tested directly against
 * a hand-counted expectation.
 *
 * **Bucketing is integer arithmetic, always.** `Math.floor(ts / grain) * grain`
 * and never a `Date` component constructor. `GetMinuteStartTimestampUTC` in
 * `tool.ts` uses the local-time `new Date(y, m, d, h, mi, 0, 0)` form and is only
 * correct because `startup.ts` forces `TZ=UTC` before anything else loads - which
 * the `vite dev` web process never imports. Anything written here has to be
 * correct in both processes, so it cannot depend on the ambient zone at all.
 */

/** Bumped when the meaning of a computed column changes, so stale rows can be found. */
export const ROLLUP_VERSION = 1;

/**
 * Sample types an operator wrote rather than a check produced.
 *
 * Everything else counts as observed. The split is what lets a report say "this
 * month's uptime is 40% overlay" instead of presenting an operator's account of
 * an outage as if it were measurement.
 */
const OVERLAY_TYPES: ReadonlySet<string> = new Set([GC.INCIDENT, GC.MAINTENANCE, GC.OPERATOR]);

/**
 * Sample types whose latency is a real measurement.
 *
 * **Deliberately narrower than "has a non-null latency".** An INCIDENT or
 * MAINTENANCE overlay row carries whatever latency the operator typed, or a
 * generated one, and `DEFAULT_STATUS` fill carries a fabricated value; folding
 * either into the distribution would make the p95 a statement about what was
 * typed. `SIGNAL` is a heartbeat receipt, not a timed request. `MANUAL` stays in
 * because a data-API push reports a latency the caller actually measured.
 *
 * `OPERATOR` is the one that is deliberately absent (KENER-123). It is an
 * operator typing into the admin screen, and before the type existed those rows
 * were MANUAL and therefore counted: thirty minutes hand-rewritten at 9000ms put
 * thirty 9000s into the distribution, so the p95 and the max on the public page
 * were reporting a number somebody typed. That is the half of KENER-123 that was
 * not merely a labelling problem.
 */
const LATENCY_TYPES: ReadonlySet<string> = new Set([GC.REALTIME, GC.TIMEOUT, GC.ERROR, GC.MANUAL]);

/** The minimum a sample must look like for the aggregation to use it. */
export interface RollupSample {
  monitor_tag: string;
  timestamp: number;
  status: string | null;
  type: string | null;
  latency: number | null;
}

/** A half-open maintenance window, in UTC seconds. */
export interface MaintenanceWindow {
  start: number;
  end: number;
}

/**
 * A bucket under construction.
 *
 * Everything here is additive except the histogram, which merges, and the
 * min/max pairs, which take extremes. That is exactly the set of operations that
 * survives folding - which is why folding a coarser grain from a finer one is
 * the same code as aggregating from raw.
 */
export interface RollupAccumulator {
  count_total: number;
  count_up: number;
  count_down: number;
  count_degraded: number;
  count_maintenance: number;
  count_no_data: number;

  count_in_maint_window: number;
  count_total_excl_maint: number;
  count_up_excl_maint: number;
  count_down_excl_maint: number;
  count_degraded_excl_maint: number;

  count_observed: number;
  count_overlay: number;

  latency_count: number;
  latency_sum: number;
  latency_min: number | null;
  latency_max: number | null;
  histogram: LatencyHistogram;

  first_ts: number | null;
  last_ts: number | null;
}

export function emptyAccumulator(): RollupAccumulator {
  return {
    count_total: 0,
    count_up: 0,
    count_down: 0,
    count_degraded: 0,
    count_maintenance: 0,
    count_no_data: 0,
    count_in_maint_window: 0,
    count_total_excl_maint: 0,
    count_up_excl_maint: 0,
    count_down_excl_maint: 0,
    count_degraded_excl_maint: 0,
    count_observed: 0,
    count_overlay: 0,
    latency_count: 0,
    latency_sum: 0,
    latency_min: null,
    latency_max: null,
    histogram: emptyHistogram(),
    first_ts: null,
    last_ts: null,
  };
}

/** The start of the bucket `ts` falls in. Integer arithmetic; see the header. */
export function bucketStartFor(ts: number, grainSeconds: number): number {
  return Math.floor(ts / grainSeconds) * grainSeconds;
}

/**
 * Whether `ts` falls inside any window.
 *
 * Linear because the list is a handful of windows for one monitor over one
 * chunk. Half-open at the end so a window ending at exactly a sample's timestamp
 * does not claim it, matching how a window's own end time reads.
 */
function inAnyWindow(ts: number, windows: ReadonlyArray<MaintenanceWindow>): boolean {
  for (const window of windows) {
    if (ts >= window.start && ts < window.end) return true;
  }
  return false;
}

function noteLatency(accumulator: RollupAccumulator, latency: number): void {
  accumulator.latency_count += 1;
  accumulator.latency_sum += latency;
  accumulator.latency_min = accumulator.latency_min === null ? latency : Math.min(accumulator.latency_min, latency);
  accumulator.latency_max = accumulator.latency_max === null ? latency : Math.max(accumulator.latency_max, latency);
  recordLatency(accumulator.histogram, latency);
}

/**
 * Aggregates raw samples into buckets of `grainSeconds`.
 *
 * `maintenanceWindows` decides the `_excl_maint` columns, and it comes from
 * `maintenances_events` rather than from the sample's own type. Those are
 * genuinely different questions: a sample can be typed MAINTENANCE with no
 * window on the books, and a window can cover samples nothing ever retyped. An
 * SLA is written about the window, so the window is what the exclusion follows.
 */
export function aggregateSamples(
  samples: ReadonlyArray<RollupSample>,
  grainSeconds: number,
  maintenanceWindows: ReadonlyArray<MaintenanceWindow> = [],
): Map<number, RollupAccumulator> {
  const buckets = new Map<number, RollupAccumulator>();

  for (const sample of samples) {
    const bucketStart = bucketStartFor(sample.timestamp, grainSeconds);
    let accumulator = buckets.get(bucketStart);
    if (!accumulator) {
      accumulator = emptyAccumulator();
      buckets.set(bucketStart, accumulator);
    }
    addSample(accumulator, sample, maintenanceWindows);
  }

  return buckets;
}

/**
 * Folds one raw sample into an accumulator.
 *
 * Exported because the read path (I9) buckets by the *viewer's* day boundary
 * rather than by a grain, so it cannot use `aggregateSamples` - but it must fold
 * a sample exactly the same way, or a live tail read at request time would
 * disagree with the sealed rollup beside it.
 */
export function addSample(
  accumulator: RollupAccumulator,
  sample: RollupSample,
  maintenanceWindows: ReadonlyArray<MaintenanceWindow> = [],
): void {
  {
    accumulator.count_total += 1;
    accumulator.first_ts =
      accumulator.first_ts === null ? sample.timestamp : Math.min(accumulator.first_ts, sample.timestamp);
    accumulator.last_ts =
      accumulator.last_ts === null ? sample.timestamp : Math.max(accumulator.last_ts, sample.timestamp);

    const status = sample.status;
    if (status === GC.UP) accumulator.count_up += 1;
    else if (status === GC.DOWN) accumulator.count_down += 1;
    else if (status === GC.DEGRADED) accumulator.count_degraded += 1;
    else if (status === GC.MAINTENANCE) accumulator.count_maintenance += 1;
    else if (status === GC.NO_DATA) accumulator.count_no_data += 1;

    const type = sample.type ?? "";
    if (OVERLAY_TYPES.has(type)) accumulator.count_overlay += 1;
    else accumulator.count_observed += 1;

    if (inAnyWindow(sample.timestamp, maintenanceWindows)) {
      accumulator.count_in_maint_window += 1;
    } else {
      accumulator.count_total_excl_maint += 1;
      if (status === GC.UP) accumulator.count_up_excl_maint += 1;
      else if (status === GC.DOWN) accumulator.count_down_excl_maint += 1;
      else if (status === GC.DEGRADED) accumulator.count_degraded_excl_maint += 1;
    }

    if (LATENCY_TYPES.has(type) && sample.latency !== null && Number.isFinite(sample.latency)) {
      noteLatency(accumulator, sample.latency);
    }
  }
}

/**
 * Folds finer buckets into coarser ones.
 *
 * **This is what keeps the cost flat.** An hourly bucket is twelve five-minute
 * rows, and a daily bucket is twenty-four hourly rows - never 288 or 1,440 raw
 * samples. The counts add, the extremes take extremes, and the histograms merge,
 * so the coarse bucket is exactly what aggregating the raw samples would have
 * produced.
 *
 * The one thing that must not happen here is averaging the stored percentile
 * columns. They are not folded at all: `accumulatorToRow` re-derives them from
 * the merged histogram, because percentiles do not average.
 */
export function foldRollups(
  rows: ReadonlyArray<MonitorRollupInput>,
  targetGrainSeconds: number,
): Map<number, RollupAccumulator> {
  const buckets = new Map<number, RollupAccumulator>();

  for (const row of rows) {
    const bucketStart = bucketStartFor(row.bucket_start, targetGrainSeconds);
    let accumulator = buckets.get(bucketStart);
    if (!accumulator) {
      accumulator = emptyAccumulator();
      buckets.set(bucketStart, accumulator);
    }
    addRollup(accumulator, row);
  }

  return buckets;
}

/**
 * Folds one rollup row into an accumulator.
 *
 * Exported for the same reason as `addSample`: the read path folds rollups into
 * buckets aligned to a viewer's timezone, which is not a grain boundary, and it
 * has to fold them identically to the way the scheduler does.
 */
export function addRollup(accumulator: RollupAccumulator, row: MonitorRollupInput): void {
  {
    accumulator.count_total += row.count_total;
    accumulator.count_up += row.count_up;
    accumulator.count_down += row.count_down;
    accumulator.count_degraded += row.count_degraded;
    accumulator.count_maintenance += row.count_maintenance;
    accumulator.count_no_data += row.count_no_data;

    accumulator.count_in_maint_window += row.count_in_maint_window;
    accumulator.count_total_excl_maint += row.count_total_excl_maint;
    accumulator.count_up_excl_maint += row.count_up_excl_maint;
    accumulator.count_down_excl_maint += row.count_down_excl_maint;
    accumulator.count_degraded_excl_maint += row.count_degraded_excl_maint;

    accumulator.count_observed += row.count_observed;
    accumulator.count_overlay += row.count_overlay;

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
    accumulator.histogram = mergeHistograms(accumulator.histogram, decodeHistogram(row.latency_histogram));

    if (row.first_ts !== null) {
      accumulator.first_ts =
        accumulator.first_ts === null ? row.first_ts : Math.min(accumulator.first_ts, row.first_ts);
    }
    if (row.last_ts !== null) {
      accumulator.last_ts = accumulator.last_ts === null ? row.last_ts : Math.max(accumulator.last_ts, row.last_ts);
    }
  }
}

/**
 * The row to upsert. Percentiles are derived here and nowhere else.
 *
 * No `org_id`: see `MonitorRollupInput`. The scoped insert stamps it, and a
 * placeholder here would silently beat the stamp.
 */
export function accumulatorToRow(
  accumulator: RollupAccumulator,
  identity: { monitor_tag: string; region_id: number; bucket_start: number },
  computedAt: number,
): MonitorRollupInput {
  const percentiles = histogramPercentiles(accumulator.histogram);
  return {
    ...identity,
    count_total: accumulator.count_total,
    count_up: accumulator.count_up,
    count_down: accumulator.count_down,
    count_degraded: accumulator.count_degraded,
    count_maintenance: accumulator.count_maintenance,
    count_no_data: accumulator.count_no_data,
    count_in_maint_window: accumulator.count_in_maint_window,
    count_total_excl_maint: accumulator.count_total_excl_maint,
    count_up_excl_maint: accumulator.count_up_excl_maint,
    count_down_excl_maint: accumulator.count_down_excl_maint,
    count_degraded_excl_maint: accumulator.count_degraded_excl_maint,
    count_observed: accumulator.count_observed,
    count_overlay: accumulator.count_overlay,
    latency_count: accumulator.latency_count,
    latency_sum: accumulator.latency_sum,
    latency_min: accumulator.latency_min,
    latency_max: accumulator.latency_max,
    latency_p50: percentiles.p50,
    latency_p90: percentiles.p90,
    latency_p95: percentiles.p95,
    latency_p99: percentiles.p99,
    latency_histogram: encodeHistogram(accumulator.histogram),
    first_ts: accumulator.first_ts,
    last_ts: accumulator.last_ts,
    computed_at: computedAt,
    rollup_version: ROLLUP_VERSION,
  };
}

/** Bucket width for a grain, from the shared table so nothing invents its own. */
export function grainSeconds(grain: RollupGrain): number {
  return ROLLUP_GRAIN_SECONDS[grain];
}

/**
 * The grain each coarser one folds from.
 *
 * `1h` from `5m` and `1d` from `1h`. `5m` folds from nothing; it is the only
 * grain that reads raw samples, which is what keeps the raw scan bounded to five
 * minutes of one monitor.
 */
export const FOLD_SOURCE: Record<RollupGrain, RollupGrain | null> = {
  "5m": null,
  "1h": "5m",
  "1d": "1h",
};
