import db from "../db/db.js";
import { rollupToSloCounts, summariseCounts, type ReportRange } from "./reportData.js";
import type { MonitorRollup } from "../types/db.js";
import type { SloTerms } from "../services/slo.js";

/**
 * The streaming CSV export (F2).
 *
 * **Nothing here is ever fully in memory.** The acceptance case is 365 days by
 * 200 monitors at hourly grain, which is 1.75 million rows; the only structure
 * this holds is the tag-to-name map, bounded by the monitor count, and one
 * outgoing text buffer that is flushed every few kilobytes. The rows themselves
 * arrive from `db.streamRollups` and leave as lines without ever being collected.
 *
 * **Per-bucket percentiles are read straight off the row, and that is correct
 * precisely because these are per-bucket.** `latency_p95` on a rollup row is
 * authoritative for its own bucket; what it cannot do is be averaged across a
 * range, which is why the PDF summary reports the mean instead and why anything
 * spanning buckets has to merge histograms. One row of this CSV is one bucket,
 * so the stored value is the right one and no merge is needed.
 *
 * **The percentile columns carry the histogram's precision, not the sample's.**
 * They are derived from 64 log-spaced buckets with a growth factor of 1.2, so a
 * bucket in which every request took exactly 100ms reports a p95 of about
 * 105ms - the representative value of the bucket that holds 100. That is a
 * property of how latency is stored, not of this export, and it is worth knowing
 * before comparing a percentile column against `latency_avg_ms`, which is an
 * exact mean of exact sums. Columns `latency_avg_ms`, `latency_min_ms` and
 * `latency_max_ms` are exact; the four percentile columns are within ~20%.
 */

const COLUMNS = [
  "monitor_tag",
  "monitor_name",
  "bucket_start",
  "bucket_start_utc",
  "count_total",
  "count_up",
  "count_down",
  "count_degraded",
  "count_maintenance",
  "count_no_data",
  "count_in_maint_window",
  "uptime_percent",
  "latency_avg_ms",
  "latency_min_ms",
  "latency_max_ms",
  "latency_p50_ms",
  "latency_p90_ms",
  "latency_p95_ms",
  "latency_p99_ms",
] as const;

/** Flush threshold. Large enough that a 1.75M-row export is not 1.75M enqueues. */
const FLUSH_BYTES = 64 * 1024;

/**
 * RFC 4180 quoting.
 *
 * Monitor names are operator-supplied free text, so they genuinely do contain
 * commas, quotes and newlines. A name containing `,` that is not quoted shifts
 * every later column on that line by one, which is a corrupt export that still
 * opens cleanly in a spreadsheet - the worst failure mode available here.
 */
function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Fixed to four decimals: enough to distinguish 99.9500 from 99.9900. */
function formatPercent(value: number | null): string {
  return value === null ? "" : value.toFixed(4);
}

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return Number(value).toFixed(2);
}

/** UTC ISO, seconds precision. Every window in this codebase is UTC and says so. */
function isoUtc(ts: number): string {
  return new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function rowToLine(row: MonitorRollup, name: string, terms: SloTerms): string {
  const { uptimePercent } = summariseCounts(rollupToSloCounts(row), terms);
  const latencyCount = Number(row.latency_count ?? 0);
  const cells = [
    csvEscape(row.monitor_tag),
    csvEscape(name),
    String(row.bucket_start),
    isoUtc(Number(row.bucket_start)),
    String(Number(row.count_total ?? 0)),
    String(Number(row.count_up ?? 0)),
    String(Number(row.count_down ?? 0)),
    String(Number(row.count_degraded ?? 0)),
    String(Number(row.count_maintenance ?? 0)),
    String(Number(row.count_no_data ?? 0)),
    String(Number(row.count_in_maint_window ?? 0)),
    formatPercent(uptimePercent),
    latencyCount > 0 ? formatMs(Number(row.latency_sum ?? 0) / latencyCount) : "",
    formatMs(row.latency_min),
    formatMs(row.latency_max),
    formatMs(row.latency_p50),
    formatMs(row.latency_p90),
    formatMs(row.latency_p95),
    formatMs(row.latency_p99),
  ];
  return cells.join(",") + "\n";
}

export interface CsvReportOptions {
  monitorTags: string[] | null;
  range: ReportRange;
  regionId: number;
  terms: SloTerms;
}

/**
 * A web `ReadableStream` of the CSV, pulled from the database on demand.
 *
 * **Backpressure is the point of the `pull` shape.** The database stream is
 * consumed through its async iterator inside `pull`, so rows are only fetched
 * when the consumer has taken what was already produced. Pushing rows into the
 * controller as fast as the database produces them would put the whole result
 * set in the queue and defeat the streaming entirely - the export would still
 * work and the memory graph would look exactly like the buffered version.
 */
export async function csvUptimeReportStream(options: CsvReportOptions): Promise<ReadableStream<Uint8Array>> {
  const { monitorTags, range, regionId, terms } = options;

  // Bounded by the monitor count, so it is safe to hold for the whole export -
  // and it is the reason the CSV can carry a human-readable name per row without
  // joining `monitors` into a 1.75-million-row query.
  const monitors = monitorTags === null ? await db.getMonitors({}) : await db.getMonitorsByTags(monitorTags);
  const nameByTag = new Map(monitors.map((monitor) => [String(monitor.tag), String(monitor.name)]));

  const encoder = new TextEncoder();
  const source = db.streamRollups(range.grain, monitorTags, regionId, range.from, range.to);
  const iterator = (source as unknown as AsyncIterable<MonitorRollup>)[Symbol.asyncIterator]();

  let buffer = COLUMNS.join(",") + "\n";
  let finished = false;

  const destroy = () => {
    const destroyable = source as unknown as { destroy?: () => void };
    if (typeof destroyable.destroy === "function") destroyable.destroy();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        while (buffer.length < FLUSH_BYTES) {
          const next = await iterator.next();
          if (next.done) {
            finished = true;
            break;
          }
          const row = next.value;
          buffer += rowToLine(row, nameByTag.get(String(row.monitor_tag)) ?? String(row.monitor_tag), terms);
        }

        if (buffer.length > 0) {
          controller.enqueue(encoder.encode(buffer));
          buffer = "";
        }
        if (finished) controller.close();
      } catch (error) {
        finished = true;
        destroy();
        // Erroring the controller aborts the HTTP response mid-body. There is no
        // way to turn a half-written CSV into a clean error page once the headers
        // are out, and a truncated file that looks complete would be worse than a
        // broken download the caller can see failed.
        controller.error(error);
      }
    },
    cancel() {
      finished = true;
      destroy();
    },
  });
}

/** Exported for the tests, which assert on quoting and column order. */
export const CSV_COLUMNS = COLUMNS;
export const __testing = { csvEscape, rowToLine, isoUtc, formatPercent };
