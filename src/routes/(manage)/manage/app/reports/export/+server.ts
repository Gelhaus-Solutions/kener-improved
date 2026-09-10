import { error, type RequestHandler } from "@sveltejs/kit";
import { authenticate } from "$lib/server/manage/middleware/authenticate";
import { requireOrg } from "$lib/server/manage/middleware/requireOrg";
import { requireMfaEnrolment } from "$lib/server/manage/middleware/requireMfa";
import { ActionError } from "$lib/server/manage/types";
import type { ActionContext } from "$lib/server/manage/types";
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
 * The Reports screen's download link (F2).
 *
 * **Why this exists next to `/api/v5/reports/uptime`, which does the same job.**
 * The two differ in exactly one thing: how the caller proves who they are. The
 * v5 route is for API keys and `hooks.server.ts` rejects anything under `/api/`
 * without a bearer token, so a browser holding only a session cookie cannot use
 * it - and a download has to be a plain navigation, because a `fetch` cannot
 * stream 1.75 million rows to disk without buffering the whole body first.
 *
 * So this route is the session-authenticated door to the same rendering code.
 * Every line below the auth block is a delegation; there is no second
 * implementation of the report here, and nothing about the document differs.
 *
 * **The layout guard does not run for endpoints.** `(manage)/+layout.server.ts`
 * checks the route permission map on page loads only, and a `+server.ts` never
 * invokes a layout - so the checks are made here explicitly, in the same order
 * the action pipeline makes them: authenticate, then MFA enrolment, then org
 * membership, then the permission itself. Leaving any of them to the layout
 * would have produced an endpoint that looks guarded and is not.
 */

const MAX_RANGE_SECONDS = 400 * 86400;

export const GET: RequestHandler = async (event) => {
  const { url, cookies } = event;

  let context: ActionContext;
  try {
    const { user, permissions, session } = await authenticate(cookies);

    context = {
      user,
      permissions,
      session,
      requestId: event.locals.requestId ?? crypto.randomUUID(),
      cookies,
      ip: null,
      userAgent: event.request.headers.get("user-agent"),
      orgId: session.active_org_id ?? 0,
    } as ActionContext;

    // A2b applies here for the same reason it applies to every action: an
    // enrolment the instance requires is not satisfied by holding a cookie.
    // The action name is only used to exempt the enrolment screens themselves,
    // and this is not one of them.
    await requireMfaEnrolment("exportReport", context);

    // Both asserts membership and enters the org, so no query below runs
    // unscoped. Order matters: this precedes every read.
    context.orgId = await requireOrg(context);

    if (!permissions.has("reports.read")) {
      throw new ActionError(403, "You do not have permission to run reports");
    }
  } catch (caught) {
    if (caught instanceof ActionError) throw error(caught.status, caught.message);
    throw error(401, "Not authorised");
  }

  const format = (url.searchParams.get("format") ?? "csv") as ReportFormat;
  if (!REPORT_FORMATS.includes(format)) throw error(400, `format must be one of ${REPORT_FORMATS.join(", ")}`);

  const scopeType = (url.searchParams.get("scope_type") ?? "ALL") as MonitorScopeType;
  if (!REPORT_SCOPE_TYPES.includes(scopeType))
    throw error(400, `scope_type must be one of ${REPORT_SCOPE_TYPES.join(", ")}`);
  const scopeRef = url.searchParams.get("scope_ref") ?? "";
  if (scopeType !== "ALL" && scopeRef === "") throw error(400, "scope_ref is required unless scope_type is ALL");

  const grain = (url.searchParams.get("grain") ?? "1d") as RollupGrain;
  if (!REPORT_GRAINS.includes(grain)) throw error(400, `grain must be one of ${REPORT_GRAINS.join(", ")}`);

  const now = GetMinuteStartNowTimestampUTC();
  const from = Number(url.searchParams.get("from") ?? now - 30 * 86400);
  const to = Number(url.searchParams.get("to") ?? now);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) {
    throw error(400, "from and to must be UTC second timestamps");
  }
  if (to <= from) throw error(400, "to must be after from");
  if (to - from > MAX_RANGE_SECONDS) throw error(400, `the range may not exceed ${MAX_RANGE_SECONDS / 86400} days`);

  const request: ReportRequest = {
    scopeType,
    scopeRef,
    from,
    to,
    grain,
    excludeMaintenance: (url.searchParams.get("exclude_maintenance") ?? "1") !== "0",
    degradedCountsAsBad: (url.searchParams.get("degraded_counts_as_bad") ?? "0") !== "0",
    regionId: MERGED_REGION_ID,
  };

  try {
    if (format === "csv") {
      const { monitorTags, range } = await prepareReport(request);
      const stream = await csvUptimeReportStream({
        monitorTags,
        range,
        regionId: MERGED_REGION_ID,
        terms: termsFrom(request),
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${filenameFor(request, range.from, range.to, "csv")}"`,
          "cache-control": "no-store",
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
      },
    });
  } catch (caught) {
    if (caught instanceof ReportUnavailableError) throw error(503, caught.message);
    throw caught;
  }
};

function filenameFor(request: ReportRequest, from: number, to: number, extension: string): string {
  const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const scope =
    request.scopeType === "ALL"
      ? "ALL"
      : `${request.scopeType}-${request.scopeRef}`.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48);
  return `uptime-${scope}-${day(from)}-${day(to)}.${extension}`;
}
