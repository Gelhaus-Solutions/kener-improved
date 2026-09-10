import db from "../db/db.js";
import { resolveScopeTags, type MonitorScopeType } from "../services/monitorScope.js";
import { describeWindow, type SloCalendarPeriod, type SloWindowType } from "../services/slo.js";
import { buildIncidentReport } from "./incidentReport.js";
import type { PdfIncidentMetrics, PdfIncidentRow, PdfSloRow } from "./pdfUptimeReport.js";
import type { ReportModel } from "./reportData.js";

/**
 * The sections of the report that are not availability arithmetic (F2, F3).
 *
 * Kept apart from `reportData.ts` because they answer a different question. The
 * report model is "how available was this"; these are "what did we promise" and
 * "how well did we respond". They are also the parts that may legitimately be
 * absent - an instance with no SLO targets and no incidents still has a valid
 * uptime report - so every one of them is optional at the render site.
 */

/**
 * The SLO targets that overlap the report's scope, with their latest evaluation.
 *
 * **Overlap, not containment.** A report on one page includes an SLO covering a
 * category that happens to contain one of that page's components, because
 * somebody reading the page's report wants to know a commitment on it exists.
 * Requiring the target's scope to sit inside the report's would hide exactly the
 * organisation-wide objectives most worth printing.
 *
 * Reads the stored evaluation rather than recomputing. The evaluations are
 * written every five minutes by `slaScheduler` over the target's *own* window,
 * which is the number the SLO screen shows and the number the burn-rate alerts
 * fired on. Recomputing over the report's range instead would print a figure
 * that is correct arithmetic but is not the target's attainment, and two
 * different "attainment" numbers for one target is worse than one.
 */
export async function collectSloRows(model: ReportModel): Promise<PdfSloRow[]> {
  const targets = await db.getSlaTargets({ status: "ACTIVE" });
  if (targets.length === 0) return [];

  const inScope = new Set(model.components.map((component) => component.monitor_tag));
  if (inScope.size === 0) return [];

  const matched: typeof targets = [];
  for (const target of targets) {
    const tags = await resolveScopeTags(target.scope_type as "MONITOR" | "PAGE" | "CATEGORY", target.scope_ref);
    if (tags.some((tag) => inScope.has(tag))) matched.push(target);
  }
  if (matched.length === 0) return [];

  const evaluations = await db.getSlaEvaluations(matched.map((target) => target.id));
  const byTarget = new Map(evaluations.map((evaluation) => [evaluation.sla_target_id, evaluation]));

  return matched.map((target) => {
    const evaluation = byTarget.get(target.id);
    return {
      name: target.name,
      objectivePercent: target.objective_percent,
      // Null when the scheduler has not evaluated this target yet, which is the
      // honest answer for a target created since the last five-minute tick.
      uptimePercent: evaluation?.uptime_percent ?? null,
      budgetRemainingPercent: evaluation?.budget_remaining_percent ?? null,
      windowLabel: describeWindow({
        windowType: target.window_type as SloWindowType,
        windowDays: target.window_days,
        calendarPeriod: target.calendar_period as SloCalendarPeriod | null,
      }),
    };
  });
}

/** Formats a trend bucket for the label the report prints beside every mean. */
function windowLabelFor(from: number, to: number): string {
  const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
  return `${day(from)} to ${day(to)} (UTC)`;
}

/**
 * The incident sections of the PDF (F3).
 *
 * F3's item asks for "inclusion in the F2 PDF so a monthly report carries both
 * uptime and incident response quality", which is why this lives here and lands
 * with F3 rather than with F2.
 *
 * **Only measures that actually have samples are printed.** A row reading
 * "Time to acknowledge: n/a over 0 incidents" is noise on a document handed to a
 * customer; a measure nobody recorded is better left off the page than printed
 * as an absence. The incident count for the window is printed once, above the
 * table, so the reader always knows the denominator even when a measure's own
 * sample count is smaller.
 */
export async function collectIncidentSections(
  scopeType: MonitorScopeType,
  scopeRef: string,
  from: number,
  to: number,
): Promise<{ metrics: PdfIncidentMetrics; incidents: PdfIncidentRow[] }> {
  const report = await buildIncidentReport({ scopeType, scopeRef, from, to });

  const metrics: PdfIncidentMetrics = {
    windowLabel: windowLabelFor(from, to),
    incidentCount: report.metrics.incidentCount,
    rows: report.metrics.measures
      .filter((measure) => measure.sampleCount > 0)
      .map((measure) => ({
        label: measure.label,
        mean: measure.mean,
        median: measure.median,
        sampleCount: measure.sampleCount,
      })),
  };

  const incidents: PdfIncidentRow[] = report.incidents.map((incident) => ({
    title: incident.title,
    severity: incident.severity,
    startedAt: incident.startedAt,
    durationSeconds: incident.durationSeconds,
    components: incident.monitorNames.join(", "),
  }));

  return { metrics, incidents };
}
