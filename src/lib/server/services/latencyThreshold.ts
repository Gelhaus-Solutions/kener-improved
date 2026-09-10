import db from "../db/db.js";
import { GetSiteDataByKey } from "../controllers/siteDataController.js";
import { currentOrgIdOrDefault } from "../db/orgContext.js";
import GC from "../../global-constants.js";

/**
 * Latency-based DEGRADED (B5).
 *
 * "DEGRADED if p95 over 800ms across 5 minutes" as a first-class threshold,
 * evaluated at check time so that the ordinary confirmation threshold damps it
 * like any other flip. There is deliberately no anti-flap logic here: escalating
 * the *observed* status is what lets the existing machinery do that job.
 */

export const LATENCY_METRICS = ["p50", "p90", "p95", "p99", "avg"] as const;
export type LatencyMetric = (typeof LATENCY_METRICS)[number];

/** How a monitor's own settings relate to the instance-wide default. */
export const LATENCY_MODES = ["INHERIT", "OFF", "CUSTOM"] as const;
export type LatencyMode = (typeof LATENCY_MODES)[number];

export interface LatencyThreshold {
  enabled: boolean;
  metric: LatencyMetric;
  /** How far back to look, in minutes. */
  window_minutes: number;
  /** Below this many samples in the window, no verdict is reached at all. */
  min_samples: number;
  degraded_ms: number;
  /** Optional second step. Absent means latency can never make a monitor DOWN. */
  down_ms?: number | null;
}

/** A monitor's own setting: a mode, plus the rule when the mode is CUSTOM. */
export interface MonitorLatencyThreshold extends Partial<LatencyThreshold> {
  mode?: LatencyMode;
}

export const SITE_DATA_KEY = "latencyThresholdDefault";

/**
 * The instance-wide default, shipped off.
 *
 * Off rather than on with generous numbers: turning latency into status is a
 * change to what the public page says, and an upgrade must never start doing
 * that on its own.
 */
export const DEFAULT_THRESHOLD: LatencyThreshold = {
  enabled: false,
  metric: "p95",
  window_minutes: 5,
  min_samples: 3,
  degraded_ms: 1000,
  down_ms: null,
};

/**
 * How long the site default is reused, per process.
 *
 * This is read on **every check of every monitor**, so an uncached read would be
 * one query per monitor per minute forever. Ten seconds matches
 * `consumerModes.ts` and is the same trade for the same reason: short enough
 * that an operator changing it sees the effect while still looking at the
 * screen, long enough that it is not a per-check query.
 */
const CACHE_TTL_MS = 10_000;
const cache = new Map<number, { value: LatencyThreshold; expiresAt: number }>();

/** Drops the cache. Called by the action that writes the default. */
export function invalidateLatencyThresholdCache(): void {
  cache.clear();
}

function coerceMetric(raw: unknown): LatencyMetric | null {
  return typeof raw === "string" && (LATENCY_METRICS as readonly string[]).includes(raw)
    ? (raw as LatencyMetric)
    : null;
}

function positive(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Reads a stored rule, falling back field by field to `DEFAULT_THRESHOLD`.
 *
 * Per field rather than all-or-nothing: a stored object written before a field
 * existed is otherwise discarded wholesale, which would silently turn somebody's
 * configured rule off. An unusable individual value falls back to the default
 * for that field only.
 */
export function parseThreshold(raw: unknown, base: LatencyThreshold = DEFAULT_THRESHOLD): LatencyThreshold {
  if (!raw || typeof raw !== "object") return { ...base };
  const o = raw as Record<string, unknown>;
  const downMs = positive(o.down_ms);
  return {
    enabled: o.enabled === true,
    metric: coerceMetric(o.metric) ?? base.metric,
    window_minutes: positive(o.window_minutes) ?? base.window_minutes,
    min_samples: positive(o.min_samples) ?? base.min_samples,
    degraded_ms: positive(o.degraded_ms) ?? base.degraded_ms,
    // Null is a meaningful value here ("latency never makes this DOWN"), so an
    // absent or unusable value is null rather than the base's.
    down_ms: downMs,
  };
}

/** The instance-wide default for the current org. */
export async function siteDefaultThreshold(): Promise<LatencyThreshold> {
  const orgId = currentOrgIdOrDefault();
  const hit = cache.get(orgId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let value: LatencyThreshold;
  try {
    value = parseThreshold(await GetSiteDataByKey(SITE_DATA_KEY));
  } catch (error) {
    // Unreachable database. Answering with the shipped default means "off",
    // which is the safe direction: a database blip must not start rewriting
    // statuses on the public page.
    console.error("latency threshold: could not read site_data, using the shipped default:", error);
    value = { ...DEFAULT_THRESHOLD };
  }

  cache.set(orgId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * The rule in force for one monitor, or null when latency must not change its
 * status.
 *
 * **The precedence is explicit, and that is the point.** A monitor carries a
 * `mode`, never a bare set of values whose emptiness has to be interpreted:
 *
 *   CUSTOM   this monitor's own numbers win
 *   OFF      no latency escalation here, whatever the instance default says
 *   INHERIT  the instance default, which is also what an absent setting means
 *
 * Without the mode, "no per-monitor values" and "per-monitor values that mean
 * off" are the same stored state, and every reader has to guess which was meant.
 */
export async function resolveThreshold(monitorSetting: unknown): Promise<LatencyThreshold | null> {
  const setting = (monitorSetting ?? {}) as MonitorLatencyThreshold;
  const mode: LatencyMode = (LATENCY_MODES as readonly string[]).includes(setting.mode ?? "")
    ? (setting.mode as LatencyMode)
    : "INHERIT";

  if (mode === "OFF") return null;

  if (mode === "CUSTOM") {
    const rule = parseThreshold(setting);
    return rule.enabled ? rule : null;
  }

  const site = await siteDefaultThreshold();
  return site.enabled ? site : null;
}

/**
 * The exact percentile of `values`, by sorting.
 *
 * **Not the stored histogram, deliberately.** `latencyHistogram.ts` is 64
 * log-spaced buckets with 1.2 growth, so it answers to within about 20% - which
 * is the right trade when merging buckets across a month, and the wrong one when
 * comparing against a threshold somebody typed. Through the histogram, "p95 over
 * 800ms" would fire somewhere between 667ms and 1000ms. Here the window is a
 * handful of rows already in memory, so the exact answer costs a sort.
 */
export function percentileOf(values: readonly number[], metric: LatencyMetric): number | null {
  if (values.length === 0) return null;
  if (metric === "avg") return values.reduce((sum, v) => sum + v, 0) / values.length;
  const q = metric === "p50" ? 0.5 : metric === "p90" ? 0.9 : metric === "p95" ? 0.95 : 0.99;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank];
}

export interface LatencySample {
  timestamp: number;
  status: string | null;
  type: string | null;
  latency: number | null;
}

export interface LatencyVerdict {
  status: string;
  /** Human phrase for `error_message`, e.g. "p95 812ms over 5m exceeds 800ms". */
  reason: string;
  measured: number;
}

/**
 * Which samples in the window may be measured.
 *
 * A timed-out or errored request has a latency that means "how long we waited
 * before giving up", not "how long the service took". Including those would let
 * an outage inflate the percentile and then be reported as slowness. Zero and
 * negative latencies are the same story: they are the absence of a measurement.
 */
export function isMeasurable(sample: LatencySample): boolean {
  if (sample.type === GC.TIMEOUT || sample.type === GC.ERROR) return false;
  return typeof sample.latency === "number" && sample.latency > 0;
}

/**
 * Decides whether latency should escalate the observed status.
 *
 * **Escalate only.** UP may become DEGRADED, or DOWN when `down_ms` is crossed.
 * A DOWN or DEGRADED the service itself reported is never softened: the service
 * said something worse than "slow", and slowness cannot argue it down.
 *
 * Returns null whenever no verdict is reached - not enough samples, nothing
 * measurable, the threshold not crossed, or the current status already at least
 * as bad. The caller leaves the check exactly as observed in every one of those
 * cases.
 */
export function evaluateLatency(
  observedStatus: string,
  currentSample: LatencySample,
  windowSamples: readonly LatencySample[],
  rule: LatencyThreshold,
): LatencyVerdict | null {
  // Only UP can be escalated. A service-reported DEGRADED is already on the
  // unhealthy side and a DOWN is worse than anything latency can say.
  if (observedStatus !== GC.UP) return null;
  // The current check must itself be measurable, or this minute has no latency
  // to judge and escalating it would attribute the window to the wrong sample.
  if (!isMeasurable(currentSample)) return null;

  const measurable = windowSamples.filter(isMeasurable);
  if (measurable.length < rule.min_samples) return null;

  const value = percentileOf(
    measurable.map((s) => s.latency as number),
    rule.metric,
  );
  if (value === null) return null;

  const rounded = Math.round(value);
  const window = `${rule.window_minutes}m`;

  if (rule.down_ms != null && value >= rule.down_ms) {
    return {
      status: GC.DOWN,
      reason: `${rule.metric} ${rounded}ms over ${window} exceeds ${rule.down_ms}ms`,
      measured: value,
    };
  }
  if (value >= rule.degraded_ms) {
    return {
      status: GC.DEGRADED,
      reason: `${rule.metric} ${rounded}ms over ${window} exceeds ${rule.degraded_ms}ms`,
      measured: value,
    };
  }
  return null;
}

/**
 * Applies the latency rule to a check result, in place (B5).
 *
 * Called from `monitorExecuteQueue` immediately after the check runs and
 * **before** `raw_status` is assigned, which is what makes the latency verdict
 * the *observed* status. Three things follow from that placement, all wanted:
 *
 *   - the ordinary confirmation threshold damps a latency flip exactly like any
 *     other, so one slow check cannot move the page and no separate anti-flap
 *     logic is needed;
 *   - the overlay merge is untouched, because incident and maintenance data are
 *     spread after the realtime data, so an active incident still wins;
 *   - the freeze gate still suppresses threshold counting during an overlay.
 *
 * Mutates and returns nothing: the caller already holds the object, and handing
 * back a copy would make it far too easy to keep using the original.
 */
export async function applyLatencyEscalation(
  monitorTag: string,
  monitorSettings: { latency_threshold?: unknown } | null | undefined,
  result: { status: string; latency: number; type: string; error_message?: string },
  nowTs: number,
): Promise<void> {
  let rule: LatencyThreshold | null;
  try {
    rule = await resolveThreshold(monitorSettings?.latency_threshold);
  } catch (error) {
    // A misconfigured rule must never cost the check its result. The status the
    // service actually reported is always the safer answer.
    console.error(`latency threshold: could not resolve the rule for ${monitorTag}`, error);
    return;
  }
  if (!rule) return;

  const current: LatencySample = {
    timestamp: nowTs,
    status: result.status,
    type: result.type,
    latency: result.latency,
  };
  // Cheap pre-check: if this minute has nothing measurable there is no verdict to
  // reach, and the window read below would be wasted work on every single check
  // of a monitor that never reports latency.
  if (!isMeasurable(current)) return;

  let previous: LatencySample[] = [];
  try {
    // A time window, not a row count: `getLatestMonitoringDataN` takes a limit,
    // and a monitor whose cron is slower than one a minute would silently read a
    // window far longer than the operator configured.
    const from = nowTs - rule.window_minutes * 60;
    previous = (await db.getMonitoringData(monitorTag, from, nowTs)) as unknown as LatencySample[];
  } catch (error) {
    console.error(`latency threshold: could not read the window for ${monitorTag}`, error);
    return;
  }

  // The current check is included: it is the most recent measurement and the one
  // the verdict is about. It is not in the table yet - the row is written later
  // in the same pass - so it has to be added by hand.
  const verdict = evaluateLatency(result.status, current, [...previous, current], rule);
  if (!verdict) return;

  result.status = verdict.status;
  result.error_message = result.error_message ? `${result.error_message} | ${verdict.reason}` : verdict.reason;
}
