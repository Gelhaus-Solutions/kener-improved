import db from "../db/db.js";
import { computeIncidentDurations } from "../incidents/metrics.js";
import {
  aggregateIncidentMetrics,
  type IncidentForAggregate,
  type IncidentMetricsReport,
  type TrendBucket,
} from "../incidents/metricsAggregate.js";
import { resolveScopeTags, type MonitorScopeType } from "../services/monitorScope.js";

/**
 * Assembling the incident response report (F3).
 *
 * The arithmetic is in `incidents/metricsAggregate.ts` and the per-incident
 * durations in `incidents/metrics.ts`; this is the part that decides which
 * incidents are in scope and pays for the sample scans.
 *
 * **MTTD is computed from raw samples, deliberately, and that is what costs.**
 * `findTrueOutageStart` walks up to a day of samples per attached monitor to
 * find the first non-UP minute, because detection lag is the gap between when a
 * thing broke and when we noticed - and only the samples know the first half of
 * that. C2c's migration note anticipated moving this to the rollups once P5
 * landed; that would be far cheaper and would quantise MTTD to the rollup grain,
 * so the per-incident screen and this aggregate would disagree by up to that
 * grain. Keeping both on raw samples keeps them identical.
 *
 * The cost is bounded two ways rather than left open: only ALERT-basis incidents
 * scan at all (`computeIncidentDurations` skips the walk for an operator-declared
 * incident, which has no detection to measure), and the number of incidents
 * examined is capped. A report that silently examined ten thousand incidents
 * would be a way to make the admin API time out.
 */

/**
 * The cap on incidents examined per request.
 *
 * F3's own item puts the expected volume at "a few hundred incidents a year", so
 * this is roughly a decade of normal operation and will not bite on any real
 * instance. It exists so that a pathological instance degrades into a truthful
 * partial answer - `truncated` is reported and every surface shows it - rather
 * than into a timeout.
 */
export const MAX_INCIDENTS_SCANNED = 2000;

export interface IncidentReportRequest {
  scopeType: MonitorScopeType;
  scopeRef: string;
  from: number;
  to: number;
  bucket?: TrendBucket;
}

export interface IncidentReportResult {
  metrics: IncidentMetricsReport;
  /** The incidents themselves, for the log section and the API. */
  incidents: Array<{
    id: number;
    title: string;
    severity: string;
    startedAt: number;
    resolvedAt: number | null;
    durationSeconds: number | null;
    monitorTags: string[];
    monitorNames: string[];
    basis: "ALERT" | "REPORTED";
  }>;
  truncated: boolean;
  scopeLabel: string;
}

export async function buildIncidentReport(request: IncidentReportRequest): Promise<IncidentReportResult> {
  const { scopeType, scopeRef, from, to } = request;

  // Null means "every monitor", and for incidents that means no filtering at
  // all rather than a list of every tag - including incidents attached to a
  // monitor that has since been deleted, which still happened.
  const scopeTags = scopeType === "ALL" ? null : new Set(await resolveScopeTags(scopeType, scopeRef));

  // One extra row, so a full page can be told from a page that merely fits.
  const rows = await db.getIncidentsForMetrics(from, to, MAX_INCIDENTS_SCANNED + 1);
  const truncated = rows.length > MAX_INCIDENTS_SCANNED;
  const incidentRows = truncated ? rows.slice(0, MAX_INCIDENTS_SCANNED) : rows;

  const tagsByIncident = await db.getMonitorTagsForIncidents(incidentRows.map((row) => row.id));

  // Scope filtering happens here rather than in SQL because an incident is in
  // scope if *any* of its components is, and the join that expresses that would
  // return an incident once per matching component - which then has to be
  // de-duplicated anyway.
  const inScope = incidentRows.filter((row) => {
    if (scopeTags === null) return true;
    const tags = tagsByIncident.get(row.id) ?? [];
    return tags.some((tag) => scopeTags.has(tag));
  });

  const names = new Map<string, string>();
  const allTags = [...new Set(inScope.flatMap((row) => tagsByIncident.get(row.id) ?? []))];
  if (allTags.length > 0) {
    for (const monitor of await db.getMonitorsByTags(allTags)) {
      names.set(String(monitor.tag), String(monitor.name));
    }
  }

  const forAggregate: IncidentForAggregate[] = [];
  const incidents: IncidentReportResult["incidents"] = [];

  for (const row of inScope) {
    const tags = tagsByIncident.get(row.id) ?? [];
    // Sequential rather than in parallel: each of these can scan a day of
    // samples per monitor, and firing hundreds at once at the database would
    // turn a slow report into an outage of its own.
    const durations = await computeIncidentDurations(row, tags);

    forAggregate.push({
      id: row.id,
      title: row.title,
      severity: row.severity,
      startedAt: row.start_date_time,
      monitorTags: tags,
      durations,
    });

    incidents.push({
      id: row.id,
      title: row.title,
      severity: row.severity,
      startedAt: row.start_date_time,
      resolvedAt: row.resolved_at ?? row.end_date_time ?? null,
      // The wall-clock length of the incident, which is not MTTR: MTTR is
      // measured from detection, and an incident that ran for an hour before
      // anyone was told has a longer duration than its MTTR.
      durationSeconds:
        (row.resolved_at ?? row.end_date_time) !== null &&
        (row.resolved_at ?? row.end_date_time)! >= row.start_date_time
          ? (row.resolved_at ?? row.end_date_time)! - row.start_date_time
          : null,
      monitorTags: tags,
      monitorNames: tags.map((tag) => names.get(tag) ?? tag),
      basis: durations.basis,
    });
  }

  const scopeLabel = scopeType === "ALL" ? "All components" : scopeRef;

  return {
    metrics: aggregateIncidentMetrics(forAggregate, from, to, request.bucket),
    incidents,
    truncated,
    scopeLabel,
  };
}
