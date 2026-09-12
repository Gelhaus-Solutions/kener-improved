/**
 * B11. What a heartbeat ping said about the run it is reporting.
 *
 * Both fields are optional because a bare GET carries neither, and that stays
 * the common case meaning exactly what it always did: "I am alive". Absent is
 * never the same as zero - an absent exit code means the job did not say,
 * whereas zero means it said it succeeded.
 */
export interface HeartbeatReport {
  exitCode?: number;
  durationMs?: number;
}

/** A day. Longer than this is a caller sending the wrong unit, or nonsense. */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

const FAILURE_WORDS = new Set(["fail", "failed", "failure", "down", "error"]);
const SUCCESS_WORDS = new Set(["ok", "success", "succeeded", "up", "pass", "passed"]);

function toInt(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  // A boolean needs no guard of its own: String(true) is not a number, so it
  // falls out as NaN below. A mutation test proved an explicit check changed
  // nothing, so it is not here pretending to earn its place.
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function pick(body: Record<string, unknown>, query: URLSearchParams, keys: string[]): unknown {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null) return body[key];
    const q = query.get(key);
    if (q !== null) return q;
  }
  return undefined;
}

/**
 * Read a report from a ping's query string and JSON body, body winning.
 *
 * Deliberately lenient. These URLs are pasted into crontabs and CI scripts and
 * then left alone for years, so a field that does not parse is dropped rather
 * than turned into an error: a heartbeat that arrived matters far more than its
 * metadata. `status=fail` is accepted alongside a numeric exit code because a
 * shell script that only knows whether it failed should not have to invent one.
 */
export function parseHeartbeatReport(body: Record<string, unknown>, query: URLSearchParams): HeartbeatReport {
  const report: HeartbeatReport = {};

  let exitCode = toInt(pick(body, query, ["exit_code", "exitCode"]));

  if (exitCode === undefined) {
    const status = String(pick(body, query, ["status"]) ?? "")
      .trim()
      .toLowerCase();
    if (FAILURE_WORDS.has(status)) exitCode = 1;
    else if (SUCCESS_WORDS.has(status)) exitCode = 0;
  }
  if (exitCode !== undefined) report.exitCode = exitCode;

  let durationMs = toInt(pick(body, query, ["duration_ms", "durationMs"]));
  if (durationMs === undefined) {
    // `time` and most CI variables report seconds, so accept those too.
    const seconds = toInt(pick(body, query, ["duration_s", "durationSeconds", "duration"]));
    if (seconds !== undefined) durationMs = seconds * 1000;
  }
  if (durationMs !== undefined && durationMs >= 0 && durationMs <= MAX_DURATION_MS) {
    report.durationMs = durationMs;
  }

  return report;
}
