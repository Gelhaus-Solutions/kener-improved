import { json, type RequestHandler } from "@sveltejs/kit";
import { MERGED_REGION_ID } from "$lib/server/db/regions";
import { GetMinuteStartNowTimestampUTC } from "$lib/server/tool";
import { REPORT_SCOPE_TYPES, type MonitorScopeType } from "$lib/server/services/monitorScope";
import {
  REPORT_FORMATS,
  REPORT_GRAINS,
  ReportUnavailableError,
  buildReportModel,
  prepareReport,
  termsFrom,
  type ReportFormat,
  type ReportRequest,
} from "$lib/server/reports/reportData";
import { csvUptimeReportStream } from "$lib/server/reports/csvUptimeReport";
import { collectIncidentSections, collectSloRows } from "$lib/server/reports/reportExtras";
import { pdfToWebStream, renderUptimePdf } from "$lib/server/reports/pdfUptimeReport";
import type { RollupGrain } from "$lib/server/types/db";

/**
 * GET /api/v5/reports/uptime?format=&scope_type=&scope_ref=&from=&to=&grain=&exclude_maintenance=
 *
 * Uptime exports, CSV or PDF (F2).
 *
 * **One route for both formats**, rather than the `uptime.csv` and `uptime.pdf`
 * the item sketched. Both answer the same question over the same validated
 * parameters and differ only in rendering, so a single route keeps one copy of
 * the parsing and one row in `ROUTE_SCOPE_MAP` - and a route missing from that
 * map is a 403, so fewer rows is fewer ways to lock an endpoint out by accident.
 * The `Content-Disposition` filename still carries the right extension, which is
 * what a browser and a `curl -O` actually go on.
 *
 * The CSV is streamed and the PDF is not, and that asymmetry is deliberate: the
 * CSV is one row per bucket and unbounded, while the PDF is a summary whose size
 * depends on the number of components, not on the length of the range.
 */

const MAX_RANGE_SECONDS = 400 * 86400;

function badRequest(message: string) {
  return json({ error: { code: "BAD_REQUEST", message } }, { status: 400 });
}

export const GET: RequestHandler = async ({ url }) => {
  const format = (url.searchParams.get("format") ?? "csv") as ReportFormat;
  if (!REPORT_FORMATS.includes(format)) {
    return badRequest(`format must be one of ${REPORT_FORMATS.join(", ")}`);
  }

  const scopeType = (url.searchParams.get("scope_type") ?? "ALL") as MonitorScopeType;
  if (!REPORT_SCOPE_TYPES.includes(scopeType)) {
    return badRequest(`scope_type must be one of ${REPORT_SCOPE_TYPES.join(", ")}`);
  }
  const scopeRef = url.searchParams.get("scope_ref") ?? "";
  if (scopeType !== "ALL" && scopeRef === "") {
    return badRequest("scope_ref is required unless scope_type is ALL");
  }

  const grain = (url.searchParams.get("grain") ?? "1d") as RollupGrain;
  if (!REPORT_GRAINS.includes(grain)) {
    return badRequest(`grain must be one of ${REPORT_GRAINS.join(", ")}`);
  }

  const now = GetMinuteStartNowTimestampUTC();
  const from = Number(url.searchParams.get("from") ?? now - 30 * 86400);
  const to = Number(url.searchParams.get("to") ?? now);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) {
    return badRequest("from and to must be UTC second timestamps");
  }
  if (to <= from) {
    return badRequest("to must be after from");
  }
  // A bound on the request rather than on the response: the CSV streams, so a
  // ten-year range would not run out of memory, it would just hold a database
  // cursor open for a very long time on a box that has other work to do.
  if (to - from > MAX_RANGE_SECONDS) {
    return badRequest(`the range may not exceed ${MAX_RANGE_SECONDS / 86400} days`);
  }

  const regionParam = url.searchParams.get("region");
  const regionId = regionParam ? Number(regionParam) : MERGED_REGION_ID;
  if (!Number.isFinite(regionId) || regionId < 0) {
    return badRequest("region must be a non-negative integer");
  }

  const request: ReportRequest = {
    scopeType,
    scopeRef,
    from,
    to,
    grain,
    // Defaults to excluding maintenance: this is the document handed to a
    // customer, and announced maintenance is the thing an availability figure is
    // conventionally measured net of.
    excludeMaintenance: (url.searchParams.get("exclude_maintenance") ?? "1") !== "0",
    degradedCountsAsBad: (url.searchParams.get("degraded_counts_as_bad") ?? "0") !== "0",
    regionId,
  };

  try {
    if (format === "csv") {
      const { monitorTags, range } = await prepareReport(request);
      const stream = await csvUptimeReportStream({
        monitorTags,
        range,
        regionId,
        terms: termsFrom(request),
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${filenameFor(request, range.from, range.to, "csv")}"`,
          // The body is generated per request and reveals scoped data; a shared
          // cache holding it would be a cross-tenant leak waiting for a proxy.
          "cache-control": "no-store",
          "x-report-range-from": String(range.from),
          "x-report-range-to": String(range.to),
          "x-report-range-clamped": range.clamped ? "1" : "0",
        },
      });
    }

    const model = await buildReportModel(request, now);
    const slos = await collectSloRows(model);
    // F3's sections, over the report's own effective range rather than the
    // requested one, so the incident log cannot mention an incident from a
    // period the uptime table above it does not cover.
    const incidentSections = await collectIncidentSections(scopeType, scopeRef, model.range.from, model.range.to);
    const doc = renderUptimePdf(model, {
      slos,
      incidentMetrics: incidentSections.metrics,
      incidents: incidentSections.incidents,
    });
    return new Response(pdfToWebStream(doc), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filenameFor(request, model.range.from, model.range.to, "pdf")}"`,
        "cache-control": "no-store",
        "x-report-range-clamped": model.range.clamped ? "1" : "0",
      },
    });
  } catch (error) {
    if (error instanceof ReportUnavailableError) {
      // 503 rather than 500: the request is valid and will work later, which is
      // a distinction anything retrying needs to be able to make.
      return json({ error: { code: "UNAVAILABLE", message: error.message } }, { status: 503 });
    }
    throw error;
  }
};

/** `uptime-ALL-20260801-20260901.csv`, with the scope reference made filename-safe. */
function filenameFor(request: ReportRequest, from: number, to: number, extension: string): string {
  const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const scope =
    request.scopeType === "ALL"
      ? "ALL"
      : `${request.scopeType}-${request.scopeRef}`.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48);
  return `uptime-${scope}-${day(from)}-${day(to)}.${extension}`;
}
