import { buildIncidentReport } from "$lib/server/reports/incidentReport.js";
import { REPORT_SCOPE_TYPES, type MonitorScopeType } from "$lib/server/services/monitorScope.js";
import { GetMinuteStartNowTimestampUTC } from "$lib/server/tool.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";
import type { TrendBucket } from "$lib/server/incidents/metricsAggregate.js";

interface Payload {
  scope_type?: string;
  scope_ref?: string;
  from?: number;
  to?: number;
  bucket?: string;
}

const BUCKETS: TrendBucket[] = ["day", "week", "month"];
const MAX_RANGE_SECONDS = 400 * 86400;

/**
 * The incident metrics panel on the Reports screen (F3).
 *
 * The same `buildIncidentReport` the v5 endpoint and the PDF use, so the panel,
 * the API and the document cannot report different MTTRs for the same window.
 *
 * Its own action rather than fields on `getReportOptions`, for the reason C2c
 * gave for splitting `getIncidentMetrics` off `getIncident`: this one can scan a
 * day of samples per incident, and the options call happens on every page load.
 */
export default {
  action: "getIncidentReport",
  permission: "reports.read",
  handler: async (data: Payload) => {
    const scopeType = (data.scope_type ?? "ALL") as MonitorScopeType;
    if (!REPORT_SCOPE_TYPES.includes(scopeType)) {
      throw new ActionError(400, `scope_type must be one of ${REPORT_SCOPE_TYPES.join(", ")}`);
    }
    const scopeRef = data.scope_ref ?? "";
    if (scopeType !== "ALL" && scopeRef === "") {
      throw new ActionError(400, "scope_ref is required unless scope_type is ALL");
    }

    if (data.bucket !== undefined && !BUCKETS.includes(data.bucket as TrendBucket)) {
      throw new ActionError(400, `bucket must be one of ${BUCKETS.join(", ")}`);
    }

    const now = GetMinuteStartNowTimestampUTC();
    const from = Number(data.from ?? now - 30 * 86400);
    const to = Number(data.to ?? now);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) {
      throw new ActionError(400, "from and to must be UTC second timestamps");
    }
    if (to <= from) throw new ActionError(400, "to must be after from");
    if (to - from > MAX_RANGE_SECONDS) {
      throw new ActionError(400, `the range may not exceed ${MAX_RANGE_SECONDS / 86400} days`);
    }

    const report = await buildIncidentReport({
      scopeType,
      scopeRef,
      from,
      to,
      bucket: (data.bucket as TrendBucket | undefined) ?? undefined,
    });

    return {
      window: { from: report.metrics.from, to: report.metrics.to, bucket: report.metrics.bucket, timezone: "UTC" },
      incident_count: report.metrics.incidentCount,
      basis: report.metrics.basis,
      measures: report.metrics.measures,
      by_severity: report.metrics.bySeverity,
      by_component: report.metrics.byComponent,
      trend: report.metrics.trend,
      incidents: report.incidents,
      truncated: report.truncated,
    };
  },
} satisfies ActionDefinition<Payload>;
