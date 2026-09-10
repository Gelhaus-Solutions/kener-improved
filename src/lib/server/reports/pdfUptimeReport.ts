import PDFDocument from "pdfkit";
import type { ReportModel } from "./reportData.js";

/**
 * The PDF export (F2).
 *
 * **`pdfkit`, explicitly not headless Chromium.** The document is a table and
 * some bars that are literally rectangles; Puppeteer would roughly triple the
 * Docker image and add a second process that can fail on a single-VPS deploy, to
 * draw them. `pdfkit` streams, has no native dependencies, and is externalised
 * by `scripts/build-server.js` like every other runtime dependency, so its
 * standard-14 font metrics are read from `node_modules` at runtime rather than
 * needing to survive bundling.
 *
 * Everything printed here comes from `ReportModel`. This file contains no
 * arithmetic beyond laying out numbers that were already decided, which is what
 * keeps it incapable of disagreeing with the CSV.
 */

const PAGE_MARGIN = 42;
const A4_WIDTH = 595.28;
const CONTENT_WIDTH = A4_WIDTH - PAGE_MARGIN * 2;

const INK = "#111827";
const MUTED = "#6B7280";
const RULE = "#E5E7EB";
const GOOD = "#46A758";
const WARN = "#F59E0B";
const BAD = "#EF4444";

/** One SLO target's standing, as the report prints it. */
export interface PdfSloRow {
  name: string;
  objectivePercent: number;
  uptimePercent: number | null;
  budgetRemainingPercent: number | null;
  windowLabel: string;
}

/** One incident, as the report's log prints it (F3 fills these). */
export interface PdfIncidentRow {
  title: string;
  severity: string;
  startedAt: number;
  durationSeconds: number | null;
  components: string;
}

/** The aggregate response figures (F3 fills these). */
export interface PdfIncidentMetrics {
  windowLabel: string;
  incidentCount: number;
  rows: Array<{ label: string; mean: number | null; median: number | null; sampleCount: number }>;
}

export interface PdfExtras {
  slos?: PdfSloRow[];
  incidentMetrics?: PdfIncidentMetrics;
  incidents?: PdfIncidentRow[];
  siteName?: string;
}

function isoUtc(ts: number): string {
  return new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function dayUtc(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function percentText(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(3)}%`;
}

/**
 * Green at or above three nines, amber above two, red below.
 *
 * Fixed thresholds rather than the report's own objective: this colour is a
 * reading aid on a table of many components, and a per-row objective would make
 * two rows with the same number different colours for reasons the page cannot
 * show. The SLO section is where attainment is judged against a commitment.
 */
function uptimeColour(value: number | null): string {
  if (value === null) return MUTED;
  if (value >= 99.9) return GOOD;
  if (value >= 99) return WARN;
  return BAD;
}

function durationText(seconds: number | null): string {
  if (seconds === null) return "n/a";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

type Doc = InstanceType<typeof PDFDocument>;

/** Starts a new page when `needed` points will not fit above the bottom margin. */
function ensureSpace(doc: Doc, needed: number): void {
  if (doc.y + needed > doc.page.height - PAGE_MARGIN) doc.addPage();
}

function sectionHeading(doc: Doc, text: string): void {
  ensureSpace(doc, 46);
  doc.moveDown(0.9);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(text, PAGE_MARGIN, doc.y);
  doc.moveDown(0.35);
  doc
    .strokeColor(RULE)
    .lineWidth(1)
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y)
    .stroke();
  doc.moveDown(0.5);
}

function coverBlock(doc: Doc, model: ReportModel, extras: PdfExtras): void {
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(20)
    .text(extras.siteName ?? "Uptime report", PAGE_MARGIN, PAGE_MARGIN);
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(11).fillColor(MUTED).text(model.scope.label);
  doc.moveDown(0.6);

  // Every window in this codebase is UTC, and every surface that shows one says
  // so rather than leaving the reader to assume their own zone.
  doc.fontSize(9).fillColor(MUTED);
  doc.text(`Range: ${dayUtc(model.range.from)} to ${dayUtc(model.range.to)} (UTC, end exclusive)`);
  doc.text(`Grain: ${model.range.grain}    Generated: ${isoUtc(model.generatedAt)}`);
  doc.text(
    `Maintenance: ${model.terms.excludeMaintenance ? "excluded from the calculation" : "counted as available"}` +
      `    Degraded: ${model.terms.degradedCountsAsBad ? "counted as unavailable" : "counted as available"}`,
  );

  // Said on the cover, not buried: the document's own range moved, and a reader
  // comparing it against a request they made needs to see that here.
  if (model.range.clamped) {
    doc
      .fillColor(WARN)
      .text(
        `Note: the range was shortened to ${dayUtc(model.range.to)} because measurement data past that point has not been finalised.`,
        { width: CONTENT_WIDTH },
      );
  }

  doc.moveDown(1);
  ensureSpace(doc, 70);
  const boxTop = doc.y;
  doc.roundedRect(PAGE_MARGIN, boxTop, CONTENT_WIDTH, 58, 6).fillColor("#F9FAFB").fill();
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(9)
    .text("Overall availability", PAGE_MARGIN + 14, boxTop + 12);
  doc
    .fillColor(uptimeColour(model.overall.uptimePercent))
    .font("Helvetica-Bold")
    .fontSize(22)
    .text(percentText(model.overall.uptimePercent), PAGE_MARGIN + 14, boxTop + 26);
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(9)
    .text(
      `${model.components.length} component${model.components.length === 1 ? "" : "s"}    ` +
        `${model.overall.verdict.good.toLocaleString("en-US")} good / ${model.overall.verdict.bad.toLocaleString("en-US")} bad` +
        (model.overall.verdict.excluded > 0
          ? `    ${model.overall.verdict.excluded.toLocaleString("en-US")} excluded for maintenance`
          : ""),
      PAGE_MARGIN + 220,
      boxTop + 34,
      { width: CONTENT_WIDTH - 234, align: "right" },
    );
  doc.y = boxTop + 58;
}

function componentTable(doc: Doc, model: ReportModel): void {
  sectionHeading(doc, "Availability by component");

  if (model.components.length === 0) {
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(MUTED)
      .text("No components in scope for this range.", PAGE_MARGIN, doc.y);
    return;
  }

  const cols = { name: PAGE_MARGIN, bar: PAGE_MARGIN + 190, pct: PAGE_MARGIN + 330, lat: PAGE_MARGIN + 410 };

  const header = () => {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
    doc.text("COMPONENT", cols.name, doc.y, { continued: false });
    const y = doc.y - 10;
    doc.text("AVAILABILITY", cols.bar, y);
    doc.text("UPTIME", cols.pct, y, { width: 70, align: "right" });
    doc.text("LATENCY AVG / MAX", cols.lat, y, { width: CONTENT_WIDTH - (cols.lat - PAGE_MARGIN), align: "right" });
    doc.moveDown(0.4);
  };
  header();

  for (const component of model.components) {
    // 22 points is one row plus its padding; checking before drawing is what
    // stops a row being split across a page boundary.
    if (doc.y + 22 > doc.page.height - PAGE_MARGIN) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    const colour = uptimeColour(component.uptimePercent);

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(INK)
      .text(component.monitor_name, cols.name, y, { width: 180, ellipsis: true, lineBreak: false });

    const barWidth = 130;
    doc
      .roundedRect(cols.bar, y + 1, barWidth, 7, 3.5)
      .fillColor(RULE)
      .fill();
    if (component.uptimePercent !== null) {
      // Clamped at a hairline so a component at 0% still shows a bar rather than
      // nothing, which would read as "no data" instead of "completely down".
      const filled = Math.max(1.5, (component.uptimePercent / 100) * barWidth);
      doc
        .roundedRect(cols.bar, y + 1, filled, 7, 3.5)
        .fillColor(colour)
        .fill();
    }

    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(colour)
      .text(percentText(component.uptimePercent), cols.pct, y, { width: 70, align: "right" });

    const latency =
      component.latencyAvgMs === null
        ? "n/a"
        : `${Math.round(component.latencyAvgMs)} / ${component.latencyMaxMs === null ? "n/a" : Math.round(component.latencyMaxMs)} ms`;
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(MUTED)
      .text(latency, cols.lat, y, { width: CONTENT_WIDTH - (cols.lat - PAGE_MARGIN), align: "right" });

    doc.y = y + 15;
  }
}

function sloSection(doc: Doc, slos: PdfSloRow[]): void {
  sectionHeading(doc, "Service level objectives");

  if (slos.length === 0) {
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(MUTED)
      .text("No SLO targets cover the components in this report.", PAGE_MARGIN, doc.y);
    return;
  }

  const cols = {
    name: PAGE_MARGIN,
    window: PAGE_MARGIN + 170,
    obj: PAGE_MARGIN + 290,
    att: PAGE_MARGIN + 360,
    budget: PAGE_MARGIN + 430,
  };
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
  const headY = doc.y;
  doc.text("TARGET", cols.name, headY);
  doc.text("WINDOW", cols.window, headY);
  doc.text("OBJECTIVE", cols.obj, headY, { width: 62, align: "right" });
  doc.text("ATTAINED", cols.att, headY, { width: 62, align: "right" });
  doc.text("BUDGET LEFT", cols.budget, headY, { width: CONTENT_WIDTH - (cols.budget - PAGE_MARGIN), align: "right" });
  doc.moveDown(0.4);

  for (const slo of slos) {
    if (doc.y + 20 > doc.page.height - PAGE_MARGIN) doc.addPage();
    const y = doc.y;
    const met = slo.uptimePercent !== null && slo.uptimePercent >= slo.objectivePercent;

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(INK)
      .text(slo.name, cols.name, y, { width: 160, ellipsis: true, lineBreak: false });
    doc.fillColor(MUTED).text(slo.windowLabel, cols.window, y, { width: 115, ellipsis: true, lineBreak: false });
    doc.fillColor(MUTED).text(`${slo.objectivePercent}%`, cols.obj, y, { width: 62, align: "right" });
    doc
      .font("Helvetica-Bold")
      .fillColor(slo.uptimePercent === null ? MUTED : met ? GOOD : BAD)
      .text(percentText(slo.uptimePercent), cols.att, y, { width: 62, align: "right" });

    // A negative remaining budget is printed as it is. "0% left" and "you are
    // four times over" are different situations and clamping would hide it,
    // which is the same decision `computeBudget` already made.
    const budget = slo.budgetRemainingPercent;
    doc
      .font("Helvetica")
      .fillColor(budget === null ? MUTED : budget < 0 ? BAD : budget < 25 ? WARN : GOOD)
      .text(budget === null ? "n/a" : `${budget.toFixed(1)}%`, cols.budget, y, {
        width: CONTENT_WIDTH - (cols.budget - PAGE_MARGIN),
        align: "right",
      });

    doc.y = y + 15;
  }
}

function incidentMetricsSection(doc: Doc, metrics: PdfIncidentMetrics): void {
  sectionHeading(doc, "Incident response");

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MUTED)
    .text(
      `${metrics.incidentCount} incident${metrics.incidentCount === 1 ? "" : "s"} in ${metrics.windowLabel}`,
      PAGE_MARGIN,
      doc.y,
    );
  doc.moveDown(0.5);

  if (metrics.rows.length === 0) {
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(MUTED)
      .text("No measurable incidents in this range.", PAGE_MARGIN, doc.y);
    return;
  }

  const cols = { label: PAGE_MARGIN, mean: PAGE_MARGIN + 200, median: PAGE_MARGIN + 300, n: PAGE_MARGIN + 400 };
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
  const headY = doc.y;
  doc.text("MEASURE", cols.label, headY);
  doc.text("MEAN", cols.mean, headY, { width: 90, align: "right" });
  doc.text("MEDIAN", cols.median, headY, { width: 90, align: "right" });
  doc.text("INCIDENTS", cols.n, headY, { width: CONTENT_WIDTH - (cols.n - PAGE_MARGIN), align: "right" });
  doc.moveDown(0.4);

  for (const row of metrics.rows) {
    if (doc.y + 20 > doc.page.height - PAGE_MARGIN) doc.addPage();
    const y = doc.y;
    doc.font("Helvetica").fontSize(9).fillColor(INK).text(row.label, cols.label, y, { width: 190 });
    doc.fillColor(INK).text(durationText(row.mean), cols.mean, y, { width: 90, align: "right" });
    doc.fillColor(INK).text(durationText(row.median), cols.median, y, { width: 90, align: "right" });
    // The count is printed beside every measure because a mean over three
    // incidents is noise, and the reader can only know that if they are told.
    doc.fillColor(MUTED).text(String(row.sampleCount), cols.n, y, {
      width: CONTENT_WIDTH - (cols.n - PAGE_MARGIN),
      align: "right",
    });
    doc.y = y + 15;
  }
}

function incidentLogSection(doc: Doc, incidents: PdfIncidentRow[]): void {
  sectionHeading(doc, "Incident log");

  if (incidents.length === 0) {
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(MUTED)
      .text("No incidents recorded in this range.", PAGE_MARGIN, doc.y);
    return;
  }

  const cols = { when: PAGE_MARGIN, title: PAGE_MARGIN + 80, sev: PAGE_MARGIN + 300, dur: PAGE_MARGIN + 380 };
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
  const headY = doc.y;
  doc.text("STARTED", cols.when, headY);
  doc.text("INCIDENT", cols.title, headY);
  doc.text("SEVERITY", cols.sev, headY, { width: 70 });
  doc.text("DURATION", cols.dur, headY, { width: CONTENT_WIDTH - (cols.dur - PAGE_MARGIN), align: "right" });
  doc.moveDown(0.4);

  for (const incident of incidents) {
    if (doc.y + 26 > doc.page.height - PAGE_MARGIN) doc.addPage();
    const y = doc.y;
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(dayUtc(incident.startedAt), cols.when, y, { width: 76 });
    doc.fillColor(INK).text(incident.title, cols.title, y, { width: 210, ellipsis: true, lineBreak: false });
    doc.fillColor(MUTED).text(incident.severity, cols.sev, y, { width: 70 });
    doc.fillColor(INK).text(durationText(incident.durationSeconds), cols.dur, y, {
      width: CONTENT_WIDTH - (cols.dur - PAGE_MARGIN),
      align: "right",
    });
    if (incident.components) {
      doc
        .fontSize(7.5)
        .fillColor(MUTED)
        .text(incident.components, cols.title, y + 10, { width: 210, ellipsis: true, lineBreak: false });
      doc.y = y + 22;
    } else {
      doc.y = y + 14;
    }
  }
}

/**
 * Page numbers, stamped after the body so the total is known.
 *
 * `bufferPages` is what makes this possible: without it the first page is
 * already flushed by the time the last one exists, and "page 1 of ?" is the
 * best any footer could say.
 */
function stampFooters(doc: Doc): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(MUTED)
      .text(`Page ${i - range.start + 1} of ${range.count}`, PAGE_MARGIN, doc.page.height - PAGE_MARGIN + 8, {
        width: CONTENT_WIDTH,
        align: "right",
      });
  }
  doc.flushPages();
}

/**
 * Renders the report and ends the document.
 *
 * Returns the `PDFDocument`, which is a Node readable stream that has already
 * been written to and closed. Callers either pipe it to a file (F4) or wrap it
 * for an HTTP response.
 */
export function renderUptimePdf(model: ReportModel, extras: PdfExtras = {}): Doc {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });

  coverBlock(doc, model, extras);
  componentTable(doc, model);
  if (extras.slos) sloSection(doc, extras.slos);
  if (extras.incidentMetrics) incidentMetricsSection(doc, extras.incidentMetrics);
  if (extras.incidents) incidentLogSection(doc, extras.incidents);

  stampFooters(doc);
  doc.end();
  return doc;
}

/** Bridges the pdfkit document into a web stream for a SvelteKit `Response`. */
export function pdfToWebStream(doc: Doc): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      doc.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      doc.on("end", () => controller.close());
      doc.on("error", (error: Error) => controller.error(error));
    },
  });
}

/** Collects the document into a buffer. Used by F4, which writes a file. */
export async function pdfToBuffer(doc: Doc): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return await new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
