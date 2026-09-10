import { json, type RequestHandler } from "@sveltejs/kit";
import { GetMinuteStartNowTimestampUTC } from "$lib/server/tool";
import { REPORT_SCOPE_TYPES, type MonitorScopeType } from "$lib/server/services/monitorScope";
import { buildIncidentReport } from "$lib/server/reports/incidentReport";
import type { TrendBucket } from "$lib/server/incidents/metricsAggregate";

/**
 * GET /api/v5/reports/incidents?scope_type=&scope_ref=&from=&to=&bucket=
 *
 * Incident response metrics: MTTD, MTTA, MTTR, time to identify and to mitigate,
 * with counts by severity and component and a trend (F3).
 *
 * **Every measure comes back with its median and its sample count, and that is
 * not optional.** A mean MTTR over three incidents is noise, and one 40-hour
 * incident drags a mean somewhere no individual incident ever was. A client that
 * renders only `mean` is rendering something misleading, so the payload makes
 * the other two impossible to miss rather than leaving them to a `verbose` flag.
 *
 * Unlike the uptime report this reads no rollups, so it has no watermark to
 * clamp to and no kill switch to honour: incidents are rows written by people
 * and by the alerting worker, and they are complete the moment they exist.
 */

const BUCKETS: TrendBucket[] = ["day", "week", "month"];
const MAX_RANGE_SECONDS = 400 * 86400;

export const GET: RequestHandler = async ({ url }) => {
  const scopeType = (url.searchParams.get("scope_type") ?? "ALL") as MonitorScopeType;
  if (!REPORT_SCOPE_TYPES.includes(scopeType)) {
    return json(
      { error: { code: "BAD_REQUEST", message: `scope_type must be one of ${REPORT_SCOPE_TYPES.join(", ")}` } },
      { status: 400 },
    );
  }
  const scopeRef = url.searchParams.get("scope_ref") ?? "";
  if (scopeType !== "ALL" && scopeRef === "") {
    return json(
      { error: { code: "BAD_REQUEST", message: "scope_ref is required unless scope_type is ALL" } },
      { status: 400 },
    );
  }

  const bucketParam = url.searchParams.get("bucket");
  if (bucketParam !== null && !BUCKETS.includes(bucketParam as TrendBucket)) {
    return json(
      { error: { code: "BAD_REQUEST", message: `bucket must be one of ${BUCKETS.join(", ")}` } },
      { status: 400 },
    );
  }

  const now = GetMinuteStartNowTimestampUTC();
  const from = Number(url.searchParams.get("from") ?? now - 30 * 86400);
  const to = Number(url.searchParams.get("to") ?? now);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) {
    return json(
      { error: { code: "BAD_REQUEST", message: "from and to must be UTC second timestamps" } },
      { status: 400 },
    );
  }
  if (to <= from) {
    return json({ error: { code: "BAD_REQUEST", message: "to must be after from" } }, { status: 400 });
  }
  if (to - from > MAX_RANGE_SECONDS) {
    return json(
      { error: { code: "BAD_REQUEST", message: `the range may not exceed ${MAX_RANGE_SECONDS / 86400} days` } },
      { status: 400 },
    );
  }

  const report = await buildIncidentReport({
    scopeType,
    scopeRef,
    from,
    to,
    bucket: (bucketParam as TrendBucket | null) ?? undefined,
  });

  return json({
    window: {
      from: report.metrics.from,
      to: report.metrics.to,
      // Named in the payload because the bucket is chosen from the range length,
      // so a client cannot infer it and a chart that guessed would mislabel.
      bucket: report.metrics.bucket,
      timezone: "UTC",
    },
    scope: { type: scopeType, ref: scopeRef },
    incident_count: report.metrics.incidentCount,
    basis: report.metrics.basis,
    measures: report.metrics.measures,
    by_severity: report.metrics.bySeverity,
    by_component: report.metrics.byComponent,
    trend: report.metrics.trend,
    incidents: report.incidents,
    // True when the incident cap bit, so a caller can tell a complete answer
    // from a truthful partial one.
    truncated: report.truncated,
  });
};
