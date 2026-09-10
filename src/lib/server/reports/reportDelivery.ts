import db from "../db/db.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import { GetNowTimestampUTC } from "../tool.js";
import emailQueue from "../queues/emailQueue.js";
import { emit } from "../events/emit.js";
import { EMAIL_CONSUMER } from "../events/consumers/email.js";
import { buildReportModel, prepareReport, termsFrom, type ReportRequest } from "./reportData.js";
import { csvUptimeReportStream } from "./csvUptimeReport.js";
import { collectIncidentSections, collectSloRows } from "./reportExtras.js";
import { pdfToBuffer, renderUptimePdf } from "./pdfUptimeReport.js";
import { buildStorageKey, generateDownloadToken, writeArtifact, writeArtifactStream } from "./artifactStore.js";
import { describeRangeKind, resolveScheduleRange, type ReportRangeKind } from "./reportSchedule.js";
import type { MonitorScopeType } from "../services/monitorScope.js";
import type { ReportScheduleRow } from "../db/repositories/reports.js";
import type { RollupGrain } from "../types/db.js";

/**
 * Rendering a scheduled report to a file, and mailing a link to it (F4).
 *
 * **A link, not an attachment.** A year of hourly CSV is hundreds of megabytes;
 * mailing that is a bounce at best and a mail server's disk at worst. The
 * artifact lands on the filesystem and the recipients get a signed, expiring URL.
 * A small CSV is attached inline as well, because a 40KB monthly summary is more
 * useful in the message than behind a click.
 *
 * **The token in that URL is a bearer credential**, which is the deliberate
 * design: recipients are auditors and customers with no Kener account, and
 * requiring a login would defeat the feature. It is 32 random bytes, unique, and
 * dead after `expires_at`.
 */

/** Attach rather than link below this. Comfortably under every mail size limit. */
const INLINE_ATTACHMENT_LIMIT = 1024 * 1024;

/** How long a download link lives. */
export const DEFAULT_LINK_TTL_SECONDS = 7 * 86400;

export function linkTtlSeconds(): number {
  const raw = Number(process.env.KENER_REPORT_LINK_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LINK_TTL_SECONDS;
}

export interface RenderedArtifact {
  artifactId: number;
  filename: string;
  format: string;
  sizeBytes: number;
  downloadToken: string;
  expiresAt: number;
  rangeFrom: number;
  rangeTo: number;
}

function filenameFor(schedule: ReportScheduleRow, from: number, to: number): string {
  const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const safe = schedule.name.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 48) || "report";
  return `${safe}-${day(from)}-${day(to)}.${schedule.format}`;
}

/**
 * Renders a schedule's report and stores it, returning the artifact.
 *
 * Must be called inside the schedule's org context; every read below is scoped.
 */
export async function renderScheduledReport(schedule: ReportScheduleRow, firedAt: number): Promise<RenderedArtifact> {
  const range = resolveScheduleRange(schedule.range_kind as ReportRangeKind, firedAt, schedule.timezone);

  const request: ReportRequest = {
    scopeType: schedule.scope_type as MonitorScopeType,
    scopeRef: schedule.scope_ref,
    from: range.from,
    to: range.to,
    grain: schedule.grain as RollupGrain,
    excludeMaintenance: schedule.exclude_maintenance === "YES",
    degradedCountsAsBad: schedule.degraded_counts_as_bad === "YES",
    regionId: MERGED_REGION_ID,
  };

  const now = GetNowTimestampUTC();
  const format = schedule.format === "csv" ? "csv" : "pdf";
  let effectiveFrom = range.from;
  let effectiveTo = range.to;
  let sizeBytes = 0;

  const storageKeyName = filenameFor(schedule, range.from, range.to);
  const storageKey = buildStorageKey(schedule.org_id, storageKeyName);

  if (format === "csv") {
    // `prepareReport` throws `ReportUnavailableError` when the rollups are not
    // trustworthy, and that propagates: a scheduled report that would be wrong
    // must fail loudly onto the schedule's `last_error` rather than be mailed.
    const prepared = await prepareReport(request);
    effectiveFrom = prepared.range.from;
    effectiveTo = prepared.range.to;
    const stream = await csvUptimeReportStream({
      monitorTags: prepared.monitorTags,
      range: prepared.range,
      regionId: MERGED_REGION_ID,
      terms: termsFrom(request),
    });
    sizeBytes = await writeArtifactStream(storageKey, stream);
  } else {
    const model = await buildReportModel(request, now);
    effectiveFrom = model.range.from;
    effectiveTo = model.range.to;
    const slos = await collectSloRows(model);
    const incidentSections = await collectIncidentSections(
      request.scopeType,
      request.scopeRef,
      model.range.from,
      model.range.to,
    );
    const doc = renderUptimePdf(model, {
      slos,
      incidentMetrics: incidentSections.metrics,
      incidents: incidentSections.incidents,
    });
    sizeBytes = await writeArtifact(storageKey, await pdfToBuffer(doc));
  }

  const downloadToken = generateDownloadToken();
  const expiresAt = now + linkTtlSeconds();
  const filename = filenameFor(schedule, effectiveFrom, effectiveTo);

  const artifactId = await db.insertReportArtifact({
    report_schedule_id: schedule.id,
    filename,
    format,
    content_type: format === "csv" ? "text/csv; charset=utf-8" : "application/pdf",
    storage_key: storageKey,
    size_bytes: sizeBytes,
    range_from: effectiveFrom,
    range_to: effectiveTo,
    download_token: downloadToken,
    expires_at: expiresAt,
    created_at: now,
  });

  return {
    artifactId,
    filename,
    format,
    sizeBytes,
    downloadToken,
    expiresAt,
    rangeFrom: effectiveFrom,
    rangeTo: effectiveTo,
  };
}

/**
 * The addresses a schedule delivers to.
 *
 * Literal addresses, plus the confirmed subscribers of any page the schedule
 * names. **Only confirmed ones**: an unconfirmed subscription is somebody who
 * typed an address, not somebody who agreed to receive mail at it, and a monthly
 * report is exactly the kind of unsolicited mail that gets a domain blocked.
 *
 * De-duplicated case-insensitively, so a person listed literally and also
 * subscribed to a named page gets one copy rather than two.
 */
export async function resolveRecipients(schedule: ReportScheduleRow): Promise<string[]> {
  const out = new Map<string, string>();

  const literal = safeJsonArray(schedule.recipients);
  for (const entry of literal) {
    if (typeof entry === "string" && entry.includes("@")) out.set(entry.toLowerCase(), entry);
  }

  const pageIds = safeJsonArray(schedule.recipient_page_ids)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (pageIds.length > 0) {
    for (const email of await db.getEmailSubscribersForPages(pageIds)) {
      out.set(email.toLowerCase(), email);
    }
  }

  return [...out.values()];
}

function safeJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Mails the artifact's link to the schedule's recipients.
 *
 * **One job per recipient**, matching `emailQueue`'s existing contract: it sends
 * to one address per job precisely so that recipients never see each other.
 */
export async function deliverArtifact(
  schedule: ReportScheduleRow,
  artifact: RenderedArtifact,
  recipients: string[],
  baseUrl: string,
): Promise<number> {
  if (recipients.length === 0) return 0;

  const downloadUrl = `${baseUrl.replace(/\/$/, "")}/reports/download/${artifact.downloadToken}`;
  const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
  const expiresOn = day(artifact.expiresAt);

  const subject = `${schedule.name}: ${day(artifact.rangeFrom)} to ${day(artifact.rangeTo)}`;
  const body = `
    <p>The scheduled report <strong>${escapeHtml(schedule.name)}</strong> is ready.</p>
    <p>It covers ${escapeHtml(describeRangeKind(schedule.range_kind as ReportRangeKind))},
       ${day(artifact.rangeFrom)} to ${day(artifact.rangeTo)} (UTC).</p>
    <p><a href="${downloadUrl}">Download ${escapeHtml(artifact.filename)}</a> (${formatBytes(artifact.sizeBytes)})</p>
    <p>This link stops working on ${expiresOn}. Anyone with the link can open the report, so treat it as confidential.</p>
  `;

  // F4b. One event for the run, then one delivery row per recipient hanging off
  // it, so a report that fails to send is on the E9 delivery log beside every
  // other failed message instead of only in the container log.
  //
  // **A real outbox event, not a synthetic id.** `event_deliveries` is UNIQUE on
  // (event_id, consumer, target_type, target_id), and that constraint is what
  // collapses a duplicate delivery after a crash. A NULL event_id would not
  // deduplicate at all - NULL is not equal to NULL - and a made-up one would put
  // rows on a log whose whole value is that every row traces to an event. So the
  // send emits one.
  //
  // The event is administrative: it exists for the audit trail and for these
  // rows, and no customer webhook is offered it. See `event-taxonomy.ts`.
  const emitted = await emit({
    org_id: schedule.org_id,
    type: "report.delivered",
    aggregate_id: schedule.id,
    payload: {
      schedule_id: schedule.id,
      schedule_name: schedule.name,
      filename: artifact.filename,
      size_bytes: artifact.sizeBytes,
      range_from: artifact.rangeFrom,
      range_to: artifact.rangeTo,
      expires_at: artifact.expiresAt,
      recipient_count: recipients.length,
    },
  });

  let queued = 0;
  for (const recipient of recipients) {
    const emailJob = {
      toEmails: [recipient],
      templateSubject: subject,
      templateHtmlBody: body,
      templateTextBody: `${schedule.name}\n\n${day(artifact.rangeFrom)} to ${day(artifact.rangeTo)} (UTC)\n\nDownload: ${downloadUrl}\nThis link stops working on ${expiresOn}.`,
      variables: {},
    };

    // Written *before* the send, so a message that never leaves is still on the
    // log. Consumer `email` rather than a new one: that consumer replays a
    // delivery's stored `request_body`, which is exactly what retrying a report
    // mail should do - resend the link that was sent, not re-render the report
    // against today's data and quietly send something else.
    const deliveryId = await createDeliveryRow(emitted.event_id, schedule.org_id, recipient, emailJob);

    await emailQueue.push({ ...emailJob, delivery_id: deliveryId });
    queued++;
  }
  return queued;
}

/**
 * The `event_deliveries` row for one recipient of one report (F4b).
 *
 * Mirrors `subscriberQueue.createDeliveryRow` down to the status, and for the
 * same reasons. Kept as its own function here rather than shared with that one
 * because the two differ in what identifies a recipient: a subscriber has a
 * method id, and a report recipient is a literal address on the schedule.
 *
 * **Never throws.** A delivery row is bookkeeping; failing the send because the
 * bookkeeping failed would turn a logging gap into a missing report.
 */
async function createDeliveryRow(
  eventId: string,
  orgId: number,
  recipient: string,
  emailJob: Record<string, unknown>,
): Promise<number | undefined> {
  // `target_id` is 128 characters. An address longer than that is far outside
  // anything real, and truncating is better than failing: the full address is on
  // `request_headers` either way, and a collision here degrades to no row rather
  // than to a wrong one, because the insert below is caught.
  const targetId = recipient.slice(0, 128);
  try {
    const now = Math.floor(Date.now() / 1000);
    await db.insertEventDeliveries([
      {
        event_id: eventId,
        org_id: orgId,
        consumer: EMAIL_CONSUMER,
        target_type: "report_recipient",
        target_id: targetId,
        // IN_FLIGHT, not PENDING: the job is already on its way to emailQueue,
        // and a PENDING row would be swept up by the relay and sent again.
        status: "IN_FLIGHT",
        attempts: 0,
        next_attempt_at: null,
        last_attempt_at: now,
        response_code: null,
        response_body: null,
        error: null,
        request_body: JSON.stringify(emailJob),
        request_headers: JSON.stringify({ to: recipient }),
        duration_ms: null,
        created_at: now,
        updated_at: now,
      },
    ]);
    const rows = await db.getEventDeliveriesByEventId(eventId);
    return rows.find((r) => r.consumer === EMAIL_CONSUMER && r.target_id === targetId)?.id;
  } catch (error) {
    console.error("report delivery: could not create a delivery row, sending anyway:", error);
    return undefined;
  }
}

/** Whether the artifact is small enough to be worth attaching as well. */
export function shouldAttachInline(artifact: RenderedArtifact): boolean {
  return artifact.sizeBytes > 0 && artifact.sizeBytes <= INLINE_ATTACHMENT_LIMIT;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
