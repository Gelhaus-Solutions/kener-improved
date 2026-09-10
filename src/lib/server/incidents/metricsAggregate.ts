import type { IncidentDurations } from "./metrics.js";

/**
 * Aggregate incident response metrics (F3).
 *
 * C2c produced the per-incident durations; this reduces a set of them to the
 * numbers an operator or an auditor reads: MTTD, MTTA, MTTR, time to identify,
 * time to mitigate, plus counts by severity and by component and a trend.
 *
 * **Pure, with no database in sight**, for the same reason `slo.ts` is: these
 * are the numbers somebody will be held to, and they should be testable by
 * writing durations on a page rather than by standing up a fixture.
 *
 * Three presentation decisions are baked into the shape rather than left to the
 * caller, because the item asks for them and because leaving them optional is
 * how a chart ends up lying:
 *
 *   - **The median travels with the mean, always.** One 40-hour incident drags a
 *     mean MTTR somewhere no individual incident ever was. Neither number is
 *     right on its own.
 *   - **The sample count travels with both.** A mean over three incidents is
 *     noise, and the only way a reader can know that is to be told how many
 *     there were.
 *   - **A measure counts only the incidents that actually have it.** An incident
 *     nobody acknowledged has a null `acknowledged_at`, and it is left out of
 *     MTTA rather than counted as zero - which would report instant
 *     acknowledgement for the incidents that were never acknowledged at all, the
 *     exact inversion of the truth. This is F3's stated acceptance criterion.
 */

const DAY = 86400;
const WEEK = 7 * DAY;

export type TrendBucket = "day" | "week" | "month";

/** One measure, with everything needed to read it honestly. */
export interface MetricSummary {
  key: "mttd" | "mtta" | "mttr" | "time_to_identify" | "time_to_mitigate";
  label: string;
  /** Seconds. Null when no incident in the window carried this measure. */
  mean: number | null;
  median: number | null;
  /** The slowest one, which is usually the one worth talking about. */
  max: number | null;
  /** How many incidents contributed. Never assume it equals the incident count. */
  sampleCount: number;
}

export interface TrendPoint {
  bucketStart: number;
  incidentCount: number;
  mttrMedian: number | null;
}

export interface IncidentForAggregate {
  id: number;
  title: string;
  severity: string;
  startedAt: number;
  monitorTags: string[];
  durations: IncidentDurations;
}

export interface IncidentMetricsReport {
  from: number;
  to: number;
  bucket: TrendBucket;
  incidentCount: number;
  measures: MetricSummary[];
  bySeverity: Array<{ severity: string; count: number }>;
  byComponent: Array<{ monitorTag: string; count: number }>;
  trend: TrendPoint[];
  /**
   * How many incidents were measured from a real detection and how many from an
   * operator's declared start.
   *
   * Surfaced because they are not the same measurement. `computeIncidentDurations`
   * already refuses to compute MTTD for a REPORTED incident; this says how much
   * of the window that was, so a reader can tell "our detection is fast" from
   * "almost nothing here was detected by a monitor at all".
   */
  basis: { alert: number; reported: number };
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** The usual definition: the average of the two middle values on an even count. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The trend bucket for a range.
 *
 * Daily under 60 days, weekly under a year, monthly beyond. The alternative was
 * a fixed monthly bucket; this gives a two-week view enough points to be a
 * shape rather than a single dot, at the cost of the bucket meaning something
 * different between two ranges - which is why every surface labels it.
 */
export function pickTrendBucket(rangeSeconds: number): TrendBucket {
  if (rangeSeconds <= 60 * DAY) return "day";
  if (rangeSeconds <= 366 * DAY) return "week";
  return "month";
}

/**
 * The start of the bucket containing `ts`, in UTC.
 *
 * **Weeks start on Monday.** 1970-01-01 was a Thursday, so a plain
 * `floor(ts / WEEK)` produces weeks that start on Thursday - which nobody reads
 * a weekly incident trend in. The three-day shift moves the origin to Monday
 * 1969-12-29 and back again.
 */
export function bucketStart(ts: number, bucket: TrendBucket): number {
  if (bucket === "day") return Math.floor(ts / DAY) * DAY;
  if (bucket === "week") return Math.floor((ts + 3 * DAY) / WEEK) * WEEK - 3 * DAY;
  const date = new Date(ts * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000);
}

/** Advances one bucket, honouring months having different lengths. */
export function nextBucket(ts: number, bucket: TrendBucket): number {
  if (bucket === "day") return ts + DAY;
  if (bucket === "week") return ts + WEEK;
  const date = new Date(ts * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000);
}

const MEASURES: Array<{ key: MetricSummary["key"]; label: string }> = [
  { key: "mttd", label: "Time to detect" },
  { key: "mtta", label: "Time to acknowledge" },
  { key: "mttr", label: "Time to resolve" },
  { key: "time_to_identify", label: "Time to identify" },
  { key: "time_to_mitigate", label: "Time to mitigate" },
];

function summarise(key: MetricSummary["key"], label: string, incidents: IncidentForAggregate[]): MetricSummary {
  // The filter is the acceptance criterion: a null duration is dropped, never
  // read as zero. `since()` in metrics.ts already returns null rather than a
  // negative or invented number, so anything surviving here is measurable.
  const values = incidents
    .map((incident) => incident.durations[key])
    .filter((value): value is number => value !== null && value !== undefined);

  return {
    key,
    label,
    mean: mean(values),
    median: median(values),
    max: values.length === 0 ? null : Math.max(...values),
    sampleCount: values.length,
  };
}

/**
 * Reduces a window's incidents to the report.
 *
 * `from` and `to` bound the trend axis, so a quiet month still produces its
 * zero-valued points rather than vanishing from the chart - an absent bucket and
 * a bucket with no incidents look identical once plotted, and only one of them
 * is good news.
 */
export function aggregateIncidentMetrics(
  incidents: IncidentForAggregate[],
  from: number,
  to: number,
  bucketOverride?: TrendBucket,
): IncidentMetricsReport {
  const bucket = bucketOverride ?? pickTrendBucket(Math.max(0, to - from));

  const bySeverity = new Map<string, number>();
  const byComponent = new Map<string, number>();
  let alert = 0;
  let reported = 0;

  for (const incident of incidents) {
    bySeverity.set(incident.severity, (bySeverity.get(incident.severity) ?? 0) + 1);
    // An incident spanning three components counts once against each of them,
    // which is what "incidents affecting this component" means. The per-component
    // counts therefore do not sum to the incident count, and the UI says so.
    for (const tag of new Set(incident.monitorTags)) {
      byComponent.set(tag, (byComponent.get(tag) ?? 0) + 1);
    }
    if (incident.durations.basis === "ALERT") alert++;
    else reported++;
  }

  const byBucket = new Map<number, IncidentForAggregate[]>();
  for (const incident of incidents) {
    const key = bucketStart(incident.startedAt, bucket);
    const list = byBucket.get(key);
    if (list) list.push(incident);
    else byBucket.set(key, [incident]);
  }

  const trend: TrendPoint[] = [];
  if (to > from) {
    for (let ts = bucketStart(from, bucket); ts < to; ts = nextBucket(ts, bucket)) {
      const inBucket = byBucket.get(ts) ?? [];
      trend.push({
        bucketStart: ts,
        incidentCount: inBucket.length,
        mttrMedian: median(
          inBucket
            .map((incident) => incident.durations.mttr)
            .filter((value): value is number => value !== null && value !== undefined),
        ),
      });
    }
  }

  return {
    from,
    to,
    bucket,
    incidentCount: incidents.length,
    measures: MEASURES.map((measure) => summarise(measure.key, measure.label, incidents)),
    bySeverity: [...bySeverity.entries()]
      .map(([severity, count]) => ({ severity, count }))
      .sort((a, b) => b.count - a.count || a.severity.localeCompare(b.severity)),
    byComponent: [...byComponent.entries()]
      .map(([monitorTag, count]) => ({ monitorTag, count }))
      .sort((a, b) => b.count - a.count || a.monitorTag.localeCompare(b.monitorTag)),
    trend,
    basis: { alert, reported },
  };
}
