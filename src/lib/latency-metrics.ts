import { Cron } from "croner";

/**
 * The latency metrics, and the sample arithmetic that decides whether one of
 * them can mean anything.
 *
 * Shared rather than server-only on purpose. The admin forms have to warn about
 * exactly the arithmetic the checker performs, and a warning computed from a
 * second copy of the rule is a warning that eventually disagrees with the rule.
 * Everything here is pure; the rule itself still lives in
 * `server/services/latencyThreshold.ts`, which re-exports the names below.
 */

export const LATENCY_METRICS = ["p50", "p90", "p95", "p99", "avg"] as const;
export type LatencyMetric = (typeof LATENCY_METRICS)[number];

/** The percentile a metric asks for, as a whole number. `avg` asks for none. */
function percentOf(metric: LatencyMetric): number | null {
  return metric === "avg" ? null : Number(metric.slice(1));
}

/** The quantile a metric asks for, in 0..1. Null for `avg`. */
export function quantileFor(metric: LatencyMetric): number | null {
  const percent = percentOf(metric);
  return percent === null ? null : percent / 100;
}

/**
 * How many samples a percentile needs before it can be anything but the maximum.
 *
 * `percentileOf` ranks at `ceil(q*n)-1`, which is the last element whenever
 * `ceil(q*n) === n`, and that holds for every `n < 1/(1-q)`. Below that count
 * "p95 over 800ms" does not mean "usually slower than 800ms", it means "any one
 * check over 800ms", so a single spike degrades the monitor. `min_samples` does
 * not help: it gates whether a verdict is reached at all, never how many of the
 * samples have to be bad.
 *
 *   p50 2, p90 10, p95 20, p99 100, avg 1
 *
 * Computed in percent rather than from the quantile because `1/(1-0.9)` is
 * 10.000000000000002 in binary floating point, and rounding that up gives 11.
 */
export function samplesBeforePercentileIsMax(metric: LatencyMetric): number {
  const percent = percentOf(metric);
  return percent === null ? 1 : Math.ceil(100 / (100 - percent));
}

/**
 * The gap between consecutive runs of a cron pattern, in seconds.
 *
 * The longest of the next few gaps, not the first: an irregular pattern such as
 * `0,1 * * * *` fires twice a minute apart and then not for an hour, and the
 * warning should be drawn from the sparse stretch rather than the dense one.
 *
 * Read in UTC deliberately. This is an estimate of how often a monitor is
 * checked, and the one-hour hole a daylight-saving change puts in a local
 * calendar is not a fact about the monitor; measured locally, the same pattern
 * would answer differently twice a year.
 *
 * Returns null for a pattern croner cannot read or one that will not fire
 * again, because "we could not tell" must not be reported as a problem.
 */
export function cronIntervalSeconds(pattern: string | null | undefined, samples = 5): number | null {
  if (!pattern || typeof pattern !== "string") return null;
  let runs: Date[] | null;
  try {
    runs = new Cron(pattern, { timezone: "UTC" }).nextRuns(samples + 1);
  } catch {
    return null;
  }
  if (!runs || runs.length < 2) return null;

  let widest = 0;
  for (let i = 1; i < runs.length; i++) {
    widest = Math.max(widest, (runs[i].getTime() - runs[i - 1].getTime()) / 1000);
  }
  return widest > 0 ? widest : null;
}

export interface LatencySampleAdvice {
  /** How many samples the window can hold at this check interval. */
  samples: number;
  /** How many it would need before the metric stops being the plain maximum. */
  required: number;
  /** The shortest whole-minute window that reaches `required`. */
  suggestedWindowMinutes: number;
}

/**
 * Whether a window and a check interval can produce enough samples for a metric,
 * and the window that could.
 *
 * Null means there is nothing to warn about: the metric needs no minimum (`avg`),
 * the window already holds enough, or the inputs are not usable numbers.
 */
export function latencySampleAdvice(
  metric: LatencyMetric,
  windowMinutes: number,
  intervalSeconds: number | null,
): LatencySampleAdvice | null {
  const required = samplesBeforePercentileIsMax(metric);
  if (required <= 1) return null;
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
  if (intervalSeconds === null || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null;

  const samples = Math.floor((windowMinutes * 60) / intervalSeconds);
  if (samples >= required) return null;

  return {
    samples,
    required,
    suggestedWindowMinutes: Math.ceil((required * intervalSeconds) / 60),
  };
}
