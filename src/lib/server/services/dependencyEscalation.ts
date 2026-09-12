import { GetSiteDataByKey } from "../controllers/siteDataController.js";
import { currentOrgIdOrDefault } from "../db/orgContext.js";
import { getMonitorDependencyView } from "../incidents/dependencyView.js";
import { isWorseImpact, liveComponentImpactFor, monitorImpactFor, type ComponentImpact } from "../incidents/impact.js";
import GC from "../../global-constants.js";

/**
 * C3c. Recording the dependency rollup instead of only displaying it.
 *
 * C3 made the graph change what a component reports, at read time, in
 * `pageStatus.applyRollup`. Nothing wrote it down. A component could read "Major
 * System Outage" because a database it depends on was down while, on the same
 * page, its 90-day bar read 100% and fully green - both correct, and computed
 * from different things: the headline through the graph, the bar from the
 * monitor's own samples.
 *
 * The contradiction is the visible half. The real hole is that the rolled-up
 * status existed only for as long as a page was being rendered, so it was absent
 * from uptime, SLO attainment, badges, the public API and every notification. A
 * dependency outage left no trace anywhere.
 *
 * So the verdict is written. Every read path then agrees without being taught
 * the graph separately, and the value is frozen as it was: editing the
 * dependency graph no longer retroactively rewrites last month's history.
 *
 * ## Where this runs, and why it is not where B5 runs
 *
 * `applyLatencyEscalation` runs *before* `raw_status` is assigned, so the
 * confirmation threshold damps a latency flip like any other. This runs
 * **after** the threshold has resolved, and both halves of that are deliberate:
 *
 *   - `raw_status` keeps meaning "what this monitor's own check observed",
 *     which is what the public page shows as "Own check" and what the grace
 *     counting reads. If this ran earlier, the monitor's own history would
 *     record its dependencies' failures as its own.
 *   - The inherited status is not damped a second time. The child's own
 *     confirmation threshold already decided that the child is really down;
 *     making the parent wait another N checks to agree delays the page for no
 *     further evidence.
 *
 * The overlay merge that follows is untouched, so a declared incident or
 * maintenance on the parent still outranks this, exactly as `derivePageStatus`
 * ranks them.
 *
 * ## Shipped off
 *
 * Recording changes what a monitor's uptime figure means and makes a parent's
 * alert rules fire for its children's outages. An upgrade must not start doing
 * either on its own, so this is one instance-wide switch, default off, on the
 * same reasoning as B5's latency default and B1d's `degradedOnDisagreement`.
 */

export const SITE_DATA_KEY = "dependencyRecording";

export interface DependencyRecording {
  enabled: boolean;
}

export const DEFAULT_RECORDING: DependencyRecording = { enabled: false };

/**
 * How long the setting is reused, per process.
 *
 * Read on every check of every monitor, so an uncached read would be one query
 * per monitor per minute forever. Ten seconds matches `latencyThreshold.ts` and
 * `consumerModes.ts`, and is the same trade for the same reason.
 */
const CACHE_TTL_MS = 10_000;
const cache = new Map<number, { value: DependencyRecording; expiresAt: number }>();

/** Drops the cache. Called by the action that writes the setting. */
export function invalidateDependencyRecordingCache(): void {
  cache.clear();
}

export function parseRecording(raw: unknown): DependencyRecording {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_RECORDING };
  return { enabled: (raw as Record<string, unknown>).enabled === true };
}

/** The instance-wide setting for the current org. */
export async function recordingEnabled(): Promise<boolean> {
  const orgId = currentOrgIdOrDefault();
  const hit = cache.get(orgId);
  if (hit && hit.expiresAt > Date.now()) return hit.value.enabled;

  let value: DependencyRecording;
  try {
    value = parseRecording(await GetSiteDataByKey(SITE_DATA_KEY));
  } catch (error) {
    // Unreachable database. Answering "off" is the safe direction: a blip must
    // not start rewriting statuses, and the read-time rollup still shows the
    // inheritance on the page in the meantime.
    console.error("dependency recording: could not read site_data, assuming off:", error);
    value = { ...DEFAULT_RECORDING };
  }

  cache.set(orgId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value.enabled;
}

export interface DependencyVerdict {
  status: string;
  /** Human phrase for `error_message`, e.g. "inherited from Postgres". */
  reason: string;
}

/**
 * Whether the graph should move this check's status, given what it observed.
 *
 * Pure, and given the graph's answer rather than fetching it, because this is
 * the piece that decides what the status page publishes and a wrong answer here
 * is invisible everywhere else.
 *
 * **Escalate only, and only from what this check saw.** `childrenImpact` deliberately
 * excludes the monitor's own state, so a status this function published a minute
 * ago cannot be fed back in and latch: each check is judged against its own
 * observation. A monitor already at least as bad as its dependencies is left
 * exactly as observed - it has its own problem and the graph has nothing to add.
 */
export function evaluateDependencyEscalation(
  observedStatus: string,
  childrenImpact: ComponentImpact,
  inheritedFrom: readonly string[],
): DependencyVerdict | null {
  const ownImpact = liveComponentImpactFor(observedStatus === GC.UP ? null : observedStatus);
  if (!isWorseImpact(childrenImpact, ownImpact)) return null;

  const status = monitorImpactFor(childrenImpact);
  // Unreachable in practice: an impact worse than this monitor's own is never
  // OPERATIONAL, which is the only one that maps to no status at all.
  if (status === null) return null;

  // Named where the names are known. A hidden or inactive dependency moves the
  // status it always moved and is still not named, which is C3b's rule and the
  // reason `inheritedFrom` can come back empty on a real escalation.
  const reason =
    inheritedFrom.length > 0 ? `inherited from ${inheritedFrom.join(", ")}` : "inherited from a dependency";
  return { status, reason };
}

/**
 * Applies the dependency rollup to a check result, in place.
 *
 * Mutates and returns nothing, like `applyLatencyEscalation`: the caller already
 * holds the object, and handing back a copy would make it far too easy to keep
 * using the original.
 */
export async function applyDependencyEscalation(
  monitorTag: string,
  result: { status: string; error_message?: string },
  nowSeconds: number,
): Promise<void> {
  let enabled: boolean;
  try {
    enabled = await recordingEnabled();
  } catch (error) {
    console.error(`dependency recording: could not resolve the setting for ${monitorTag}`, error);
    return;
  }
  if (!enabled) return;

  let view: Awaited<ReturnType<typeof getMonitorDependencyView>>;
  try {
    view = await getMonitorDependencyView(monitorTag, nowSeconds);
  } catch (error) {
    // A graph that cannot be read must never cost the check its result. The
    // status the monitor actually reported is always the safer answer.
    console.error(`dependency recording: could not read the graph for ${monitorTag}`, error);
    return;
  }

  const verdict = evaluateDependencyEscalation(result.status, view.childrenImpact, view.inheritedFrom);
  if (!verdict) return;

  result.status = verdict.status;
  result.error_message = result.error_message ? `${result.error_message} | ${verdict.reason}` : verdict.reason;
}
