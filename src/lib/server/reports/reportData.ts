import db from "../db/db.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import { rollupsUsable } from "../services/uptimeAggregator.js";
import { describeScope, resolveScopeTags, type MonitorScopeType } from "../services/monitorScope.js";
import {
  classify,
  computeBudget,
  emptySloCounts,
  type SloCounts,
  type SloTerms,
  type SloVerdict,
} from "../services/slo.js";
import { ROLLUP_GRAIN_SECONDS, type MonitorRollup, type RollupGrain } from "../types/db.js";

/**
 * The one model both export formats are built from (F2).
 *
 * The item's requirement is that CSV and PDF "can never disagree on the
 * numbers", and the way that is enforced here is that neither of them contains
 * any arithmetic. Both call `classify()` from `services/slo.ts` - the same
 * function the SLO evaluator uses - so a report, an error budget and the
 * attainment panel are three renderings of one calculation rather than three
 * calculations that happen to agree today.
 *
 * The split between the two formats is about *shape*, not about maths:
 *
 *   - the PDF wants a **summary**, one row per component, which is bounded by the
 *     number of monitors and is therefore built eagerly here;
 *   - the CSV wants **every bucket**, which is unbounded and is therefore
 *     streamed by `csvUptimeReport.ts` rather than assembled.
 *
 * `summariseCounts` and `bucketVerdict` are what the two share.
 */

export type ReportFormat = "csv" | "pdf";

export const REPORT_FORMATS: readonly ReportFormat[] = ["csv", "pdf"];
export const REPORT_GRAINS: readonly RollupGrain[] = ["5m", "15m", "1h", "1d"];

/** Raised when the request is answerable but the data behind it is not trustworthy. */
export class ReportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportUnavailableError";
  }
}

export interface ReportRequest {
  scopeType: MonitorScopeType;
  scopeRef: string;
  /** UTC seconds, inclusive. */
  from: number;
  /** UTC seconds, exclusive. */
  to: number;
  grain: RollupGrain;
  excludeMaintenance: boolean;
  degradedCountsAsBad: boolean;
  regionId?: number;
}

export interface ReportRange {
  /** Snapped down to a grain boundary, because that is what a bucket start is. */
  from: number;
  /** Exclusive, snapped down, and never past the rollup watermark. */
  to: number;
  /** What the caller asked for, before clamping. */
  requestedTo: number;
  grain: RollupGrain;
  /**
   * True when `to` was pulled back because the rollups have not sealed that far.
   *
   * Surfaced rather than silently applied: a report whose range quietly differs
   * from the range on its own cover page is the kind of thing an auditor is
   * entitled to be annoyed about, so both the PDF and the API response say so.
   */
  clamped: boolean;
}

export interface ReportComponent {
  monitor_tag: string;
  monitor_name: string;
  verdict: SloVerdict;
  uptimePercent: number | null;
  latencyAvgMs: number | null;
  latencyMinMs: number | null;
  latencyMaxMs: number | null;
}

export interface ReportModel {
  generatedAt: number;
  scope: { type: MonitorScopeType; ref: string; label: string };
  range: ReportRange;
  terms: SloTerms;
  /** Null means "every monitor in the org", which the ALL scope uses. */
  monitorTags: string[] | null;
  components: ReportComponent[];
  overall: { verdict: SloVerdict; uptimePercent: number | null };
}

function snapDown(ts: number, seconds: number): number {
  return Math.floor(ts / seconds) * seconds;
}

export function termsFrom(request: ReportRequest): SloTerms {
  return {
    excludeMaintenance: request.excludeMaintenance,
    degradedCountsAsBad: request.degradedCountsAsBad,
  };
}

/**
 * The range the report can actually be built over.
 *
 * Two adjustments, both of which make the document honest rather than convenient:
 *
 * **Snapped to grain boundaries**, because a rollup bucket starts on one. Asking
 * for 10:37 at hourly grain and getting the 10:00 bucket back would either
 * include forty minutes nobody asked for or drop them silently; snapping the
 * request and reporting the snapped range is the only version where the numbers
 * match the label.
 *
 * **Clamped to the watermark.** Rollups exist up to the point the engine has
 * sealed, which trails real time by `ROLLUP_LAG_SECONDS`. A range running to
 * `now` would end with a partial or missing bucket and read as a dip in
 * availability that never happened. So the end is pulled back to the last
 * boundary at or below the watermark, and `clamped` records that it moved.
 */
export function resolveReportRange(from: number, to: number, grain: RollupGrain, watermark: number): ReportRange {
  const seconds = ROLLUP_GRAIN_SECONDS[grain];
  const snappedFrom = snapDown(from, seconds);
  const requestedTo = snapDown(to, seconds);
  const sealedTo = snapDown(watermark, seconds);
  const effectiveTo = Math.min(requestedTo, sealedTo);

  return {
    from: snappedFrom,
    to: Math.max(snappedFrom, effectiveTo),
    requestedTo,
    grain,
    clamped: effectiveTo < requestedTo,
  };
}

/** Attainment for one set of counts, under the report's terms. */
export function summariseCounts(
  counts: SloCounts,
  terms: SloTerms,
): { verdict: SloVerdict; uptimePercent: number | null } {
  const verdict = classify(counts, terms);
  // `computeBudget` at a 100% objective is just "good over total", and reusing it
  // rather than dividing here keeps the one definition of uptime in one file.
  const uptimePercent = computeBudget(verdict, 100).uptimePercent;
  return { verdict, uptimePercent };
}

/**
 * The counts a single rollup row contributes, in the shape `classify` takes.
 *
 * Used by the CSV writer per row. A `MonitorRollup` already carries every field
 * of `SloCounts` under the same names, so this is a projection rather than a
 * conversion - but it is written out explicitly so that a column added to the
 * rollup table cannot silently change what a report row means.
 */
export function rollupToSloCounts(row: MonitorRollup): SloCounts {
  return {
    count_up: Number(row.count_up ?? 0),
    count_down: Number(row.count_down ?? 0),
    count_degraded: Number(row.count_degraded ?? 0),
    count_maintenance: Number(row.count_maintenance ?? 0),
    count_in_maint_window: Number(row.count_in_maint_window ?? 0),
    count_up_excl_maint: Number(row.count_up_excl_maint ?? 0),
    count_down_excl_maint: Number(row.count_down_excl_maint ?? 0),
    count_degraded_excl_maint: Number(row.count_degraded_excl_maint ?? 0),
  };
}

/**
 * Resolves the scope and the range, and refuses when the rollups cannot answer.
 *
 * Shared by both formats and by the scheduled path, so a schedule that would
 * produce a wrong document fails loudly at render time rather than emailing it.
 */
export async function prepareReport(request: ReportRequest): Promise<{
  monitorTags: string[] | null;
  range: ReportRange;
  regionId: number;
  label: string;
}> {
  const regionId = request.regionId ?? MERGED_REGION_ID;

  // The same kill switch the rest of the read path honours. An export is the
  // worst surface to serve half-built rollups from: the page redraws in a minute
  // and a PDF in somebody's inbox does not.
  if (!(await rollupsUsable(request.grain))) {
    throw new ReportUnavailableError(
      "Rollups are not available for this grain yet, so an export would be incomplete. Try again once the backfill has finished.",
    );
  }

  const state = await db.getRollupState(request.grain, regionId);
  const watermark = state?.watermark_ts ?? 0;

  const range = resolveReportRange(request.from, request.to, request.grain, watermark);

  // ALL passes null rather than every tag: `table()` scopes to the org already,
  // so the `whereIn` would be thousands of redundant bind parameters.
  const monitorTags = request.scopeType === "ALL" ? null : await resolveScopeTags(request.scopeType, request.scopeRef);
  const label = await describeScope(request.scopeType, request.scopeRef);

  return { monitorTags, range, regionId, label };
}

/**
 * The bounded per-component summary: what the PDF prints and the screen shows.
 *
 * Both halves are grouped in SQL - `getSloCounts` for the statuses and
 * `getLatencySummary` for the latency - so the cost is one row per monitor
 * regardless of how long the range is. A year-long report is no more expensive
 * here than a day-long one, which is what makes it safe to render on request.
 */
export async function buildReportModel(request: ReportRequest, nowTs: number): Promise<ReportModel> {
  const { monitorTags, range, regionId, label } = await prepareReport(request);
  const terms = termsFrom(request);

  // A null tag list means the whole org, and the summary readers want a real
  // list, so it is resolved here - bounded by monitor count, unlike the buckets.
  const tags = monitorTags ?? (await resolveScopeTags("ALL", ""));

  const empty: ReportModel = {
    generatedAt: nowTs,
    scope: { type: request.scopeType, ref: request.scopeRef, label },
    range,
    terms,
    monitorTags,
    components: [],
    overall: { verdict: { good: 0, bad: 0, total: 0, excluded: 0 }, uptimePercent: null },
  };
  if (tags.length === 0 || range.to <= range.from) return empty;

  const [countsByTag, latencyByTag, monitors] = await Promise.all([
    db.getSloCounts(request.grain, tags, regionId, range.from, range.to),
    db.getLatencySummary(request.grain, tags, regionId, range.from, range.to),
    db.getMonitorsByTags(tags),
  ]);

  const nameByTag = new Map(monitors.map((monitor) => [String(monitor.tag), String(monitor.name)]));

  const components: ReportComponent[] = tags.map((tag) => {
    const counts = countsByTag.get(tag) ?? emptySloCounts();
    const { verdict, uptimePercent } = summariseCounts(counts, terms);
    const latency = latencyByTag.get(tag);
    return {
      monitor_tag: tag,
      // Falls back to the tag rather than to an empty cell: a report listing a
      // blank component name is unreadable, and the tag is always meaningful.
      monitor_name: nameByTag.get(tag) ?? tag,
      verdict,
      uptimePercent,
      latencyAvgMs: latency && latency.count > 0 ? latency.sum / latency.count : null,
      latencyMinMs: latency?.min ?? null,
      latencyMaxMs: latency?.max ?? null,
    };
  });

  // Sorted worst-first: the component that broke the month is the one somebody
  // opened the report to find, and it should not be on page three.
  components.sort((a, b) => {
    if (a.uptimePercent === null) return 1;
    if (b.uptimePercent === null) return -1;
    if (a.uptimePercent !== b.uptimePercent) return a.uptimePercent - b.uptimePercent;
    return a.monitor_name.localeCompare(b.monitor_name);
  });

  // The overall figure pools every component's samples, which is the AVERAGE
  // combination in SLO terms. WORST is a target's choice about a contract; a
  // report header is describing the estate, and pooling is what "our uptime was"
  // means there.
  const pooled = components.reduce(
    (into, component) => {
      into.good += component.verdict.good;
      into.bad += component.verdict.bad;
      into.excluded += component.verdict.excluded;
      return into;
    },
    { good: 0, bad: 0, total: 0, excluded: 0 } as SloVerdict,
  );
  pooled.total = pooled.good + pooled.bad;

  return {
    ...empty,
    components,
    overall: { verdict: pooled, uptimePercent: computeBudget(pooled, 100).uptimePercent },
  };
}
