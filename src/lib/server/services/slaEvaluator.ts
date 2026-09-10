import db from "../db/db.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import { addSample, emptyAccumulator } from "./rollupCompute.js";
import { rollupsUsable } from "./uptimeAggregator.js";
import { resolveScopeTags, type MonitorScopeType } from "./monitorScope.js";
import {
  BURN_WINDOWS,
  addSloCounts,
  burnRate,
  classify,
  combineVerdicts,
  computeBudget,
  emptySloCounts,
  resolveWindow,
  type SloCombination,
  type SloCalendarPeriod,
  type SloCounts,
  type SloTerms,
  type SloVerdict,
  type SloWindowType,
} from "./slo.js";
import type { SlaEvaluationRow, SlaTargetRow } from "../db/repositories/sla.js";

const HOUR = 3600;

/** Snaps down to the hour, which is the grain every SLO read uses. */
function hourStart(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR;
}

/**
 * The monitor tags a target's scope resolves to.
 *
 * **Hidden and inactive monitors are deliberately included.** An SLO is a
 * contract about a service, and taking a component off the public page does not
 * take it out of the contract. This is the opposite of the public-visibility
 * rule in `publicMonitorResolver`, and for a different reason: that one decides
 * what a stranger may *see*, this one decides what a number is computed *from*.
 * The public panel filters what it displays; it never changes what was measured.
 *
 * The resolution itself moved to `services/monitorScope.ts` when F2 needed the
 * same three scope types for reports. Two copies that were supposed to agree is
 * the shape of bug this repository keeps finding, so there is one.
 */
export async function resolveScope(target: SlaTargetRow): Promise<string[]> {
  return await resolveScopeTags(target.scope_type as MonitorScopeType, target.scope_ref);
}

/**
 * Sums the SLO counts for each tag over `[start, end)`.
 *
 * Sealed history from the hourly rollups, the still-moving tail from raw
 * samples, exactly as `readUptimeBuckets` does it - and for the same reason.
 * The two meet without a gap or an overlap because `start` is snapped to the
 * hour and `advanceWatermark` only ever seals whole hours, so every rollup
 * bucket in range lies entirely inside it and the raw read picks up precisely
 * what the watermark has not sealed.
 *
 * Falls back to raw for the whole window when the rollups are not trustworthy,
 * which is the same kill switch the rest of the read path honours.
 */
async function readCounts(
  monitorTags: ReadonlyArray<string>,
  regionId: number,
  start: number,
  end: number,
): Promise<Map<string, SloCounts>> {
  const out = new Map<string, SloCounts>();
  if (monitorTags.length === 0 || end <= start) return out;
  for (const tag of monitorTags) out.set(tag, emptySloCounts());

  const usable = regionId === MERGED_REGION_ID && (await rollupsUsable("1h"));
  const state = usable ? await db.getRollupState("1h", regionId) : undefined;
  // Without a trustworthy watermark the whole window is live, so everything is
  // read from raw rather than from a rollup table that may be half built.
  const watermark = usable ? (state?.watermark_ts ?? start) : start;

  const sealedEnd = Math.min(end, watermark);
  if (usable && sealedEnd > start) {
    const sealed = await db.getSloCounts("1h", monitorTags, regionId, start, sealedEnd);
    for (const [tag, counts] of sealed) {
      const into = out.get(tag);
      if (into) addSloCounts(into, counts);
    }
  }

  const liveStart = Math.max(start, watermark);
  if (end > liveStart) {
    const windowsByTag = await db.getMaintenanceWindowsForRollup(monitorTags, liveStart, end);
    for (const tag of monitorTags) {
      const samples = await db.getRawSamplesForRollup(tag, regionId, liveStart, end);
      if (samples.length === 0) continue;
      // The rollup accumulator classifies a sample against its maintenance
      // windows in exactly one place, and this reuses it rather than writing a
      // second copy of that rule which could drift from what the rollups stored.
      const accumulator = emptyAccumulator();
      const windows = windowsByTag.get(tag) ?? [];
      for (const sample of samples) addSample(accumulator, sample, windows);
      const into = out.get(tag);
      if (into) addSloCounts(into, accumulator);
    }
  }

  return out;
}

function termsFor(target: SlaTargetRow): SloTerms {
  return {
    excludeMaintenance: target.exclude_maintenance === "YES",
    degradedCountsAsBad: target.degraded_counts_as_bad === "YES",
  };
}

/** Reads a window and reduces it to one verdict under the target's terms. */
async function verdictOver(
  target: SlaTargetRow,
  monitorTags: ReadonlyArray<string>,
  start: number,
  end: number,
): Promise<SloVerdict> {
  const counts = await readCounts(monitorTags, target.region_id, start, end);
  const terms = termsFor(target);
  const perMonitor = monitorTags.map((tag) => classify(counts.get(tag) ?? emptySloCounts(), terms));
  return combineVerdicts(perMonitor, target.combination as SloCombination);
}

/**
 * Evaluates one target as of `nowTs`.
 *
 * Returns the row to store. Nothing is written here: the scheduler owns the
 * write, and keeping the computation free of it is what lets a driver ask for an
 * evaluation without one.
 */
export async function evaluateTarget(target: SlaTargetRow, nowTs: number): Promise<SlaEvaluationRow> {
  const monitorTags = await resolveScope(target);

  const window = resolveWindow(
    {
      windowType: target.window_type as SloWindowType,
      windowDays: target.window_days,
      calendarPeriod: target.calendar_period as SloCalendarPeriod | null,
    },
    nowTs,
  );
  const start = hourStart(window.start);

  const verdict = await verdictOver(target, monitorTags, start, window.end);
  const budget = computeBudget(verdict, target.objective_percent);

  const burns: Record<string, number | null> = {};
  for (const burnWindow of BURN_WINDOWS) {
    // Snapped to the hour like the main window, so the same no-gap argument
    // holds. A burn window is a rate over a period, so measuring it over
    // slightly more than the nominal hour is not a distortion - and it is far
    // better than reading a partial rollup bucket that is not there.
    const burnStart = hourStart(nowTs - burnWindow.seconds);
    const burnVerdict = await verdictOver(target, monitorTags, burnStart, nowTs);
    burns[burnWindow.key] = burnRate(burnVerdict, target.objective_percent);
  }

  return {
    sla_target_id: target.id,
    window_start: start,
    window_end: window.end,
    count_total: verdict.total,
    count_good: verdict.good,
    count_bad: verdict.bad,
    count_excluded: verdict.excluded,
    uptime_percent: finite(budget.uptimePercent),
    objective_percent: target.objective_percent,
    budget_total: finite(budget.budgetTotal),
    budget_consumed: budget.budgetConsumed,
    budget_remaining_percent: finite(budget.budgetRemainingPercent),
    burn_1h: finite(burns["1h"]),
    burn_6h: finite(burns["6h"]),
    burn_24h: finite(burns["24h"]),
    burn_3d: finite(burns["3d"]),
    monitor_count: monitorTags.length,
    computed_at: nowTs,
  };
}

/**
 * `Infinity` is a real answer here - a 100% objective with any bad sample burns
 * infinitely fast - but it is not a number any of the three dialects will store
 * in a double column. Persisted as null, which the UI already renders as "no
 * figure" rather than as zero.
 */
function finite(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value;
}

/** Evaluates every active target in the current org and stores the results. */
export async function evaluateAllTargets(nowTs: number): Promise<{ evaluated: number }> {
  const targets = await db.getSlaTargets({ status: "ACTIVE" });
  let evaluated = 0;
  for (const target of targets) {
    // One target failing must not cost the rest their evaluation: a scope
    // pointing at a deleted page is a configuration mistake, not a reason for
    // every other contract on the instance to go stale.
    try {
      const row = await evaluateTarget(target, nowTs);
      await db.upsertSlaEvaluation(row);
      evaluated++;
    } catch (error) {
      console.error(`slaEvaluator: target ${target.id} (${target.name}) failed to evaluate`, error);
    }
  }
  return { evaluated };
}
