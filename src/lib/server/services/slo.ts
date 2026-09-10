/**
 * The SLO arithmetic (F1a).
 *
 * Pure functions with no database in sight, for the same reason `rollupCompute`
 * is: this is the maths that decides whether somebody's contract was met, and it
 * should be testable by writing counts on a page rather than by standing up a
 * scheduler.
 *
 * **An SLO deliberately does not use the monitor's display uptime formula.**
 * `monitor_settings_json.uptime_formula_numerator` exists so an operator can
 * decide what the *bar on the page* shows. An SLO is a contract, and its terms
 * are its own: which statuses count as bad, and whether announced maintenance is
 * excluded, are properties of the target, set when the target is written. Letting
 * a display preference move an SLO number would mean editing a chart silently
 * restated the month's attainment.
 */

export type SloScopeType = "MONITOR" | "PAGE" | "CATEGORY";
export type SloCombination = "WORST" | "AVERAGE";
export type SloWindowType = "ROLLING" | "CALENDAR";
export type SloCalendarPeriod = "MONTH" | "QUARTER" | "YEAR";

export const SLO_SCOPE_TYPES: readonly SloScopeType[] = ["MONITOR", "PAGE", "CATEGORY"];
export const SLO_COMBINATIONS: readonly SloCombination[] = ["WORST", "AVERAGE"];
export const SLO_WINDOW_TYPES: readonly SloWindowType[] = ["ROLLING", "CALENDAR"];
export const SLO_CALENDAR_PERIODS: readonly SloCalendarPeriod[] = ["MONTH", "QUARTER", "YEAR"];

const DAY = 86400;

/** The burn-rate windows, in seconds. The names are the stored column suffixes. */
export const BURN_WINDOWS: ReadonlyArray<{ key: "1h" | "6h" | "24h" | "3d"; seconds: number }> = [
  { key: "1h", seconds: 3600 },
  { key: "6h", seconds: 6 * 3600 },
  { key: "24h", seconds: DAY },
  { key: "3d", seconds: 3 * DAY },
];

/**
 * The counts an SLO reads out of a rollup bucket, summed over some window.
 *
 * A subset of `RollupAccumulator` - the fields that bear on "was this good or
 * bad" - so a caller can hand over either a summed rollup row or a live-tail
 * accumulator without converting.
 */
export interface SloCounts {
  count_up: number;
  count_down: number;
  count_degraded: number;
  count_maintenance: number;
  count_in_maint_window: number;
  count_up_excl_maint: number;
  count_down_excl_maint: number;
  count_degraded_excl_maint: number;
}

export function emptySloCounts(): SloCounts {
  return {
    count_up: 0,
    count_down: 0,
    count_degraded: 0,
    count_maintenance: 0,
    count_in_maint_window: 0,
    count_up_excl_maint: 0,
    count_down_excl_maint: 0,
    count_degraded_excl_maint: 0,
  };
}

export function addSloCounts(into: SloCounts, from: SloCounts): void {
  into.count_up += from.count_up;
  into.count_down += from.count_down;
  into.count_degraded += from.count_degraded;
  into.count_maintenance += from.count_maintenance;
  into.count_in_maint_window += from.count_in_maint_window;
  into.count_up_excl_maint += from.count_up_excl_maint;
  into.count_down_excl_maint += from.count_down_excl_maint;
  into.count_degraded_excl_maint += from.count_degraded_excl_maint;
}

export interface SloTerms {
  excludeMaintenance: boolean;
  degradedCountsAsBad: boolean;
}

export interface SloVerdict {
  good: number;
  bad: number;
  /** good + bad. The denominator, and deliberately not the sample count. */
  total: number;
  /** Samples dropped because they fell inside a maintenance window. */
  excluded: number;
}

/**
 * Splits summed counts into good, bad and excluded under a target's terms.
 *
 * **The denominator is `good + bad`, not the total number of samples.** A
 * NO_DATA sample is the monitor saying nothing was recorded - the check did not
 * run, the instance was down, the row was never written - and counting that as a
 * breach would charge the error budget for the monitoring system's own gaps. The
 * same goes for a MAINTENANCE-typed sample that no maintenance window covers.
 * Both are outside the verdict entirely, which is why they appear in neither
 * side of this split.
 */
export function classify(counts: SloCounts, terms: SloTerms): SloVerdict {
  if (terms.excludeMaintenance) {
    const up = counts.count_up_excl_maint;
    const down = counts.count_down_excl_maint;
    const degraded = counts.count_degraded_excl_maint;
    const good = up + (terms.degradedCountsAsBad ? 0 : degraded);
    const bad = down + (terms.degradedCountsAsBad ? degraded : 0);
    return { good, bad, total: good + bad, excluded: counts.count_in_maint_window };
  }

  // Not excluding maintenance: a maintenance sample counts as good, matching the
  // default display formula (`up + maintenance` over `up + down + degraded +
  // maintenance`). An operator who does not want that has `exclude_maintenance`.
  const good = counts.count_up + counts.count_maintenance + (terms.degradedCountsAsBad ? 0 : counts.count_degraded);
  const bad = counts.count_down + (terms.degradedCountsAsBad ? counts.count_degraded : 0);
  return { good, bad, total: good + bad, excluded: 0 };
}

export interface SloBudget {
  uptimePercent: number | null;
  /** Bad samples the objective allows over this window. */
  budgetTotal: number | null;
  budgetConsumed: number;
  /** 100 = untouched, 0 = exactly exhausted, negative = overspent. */
  budgetRemainingPercent: number | null;
}

/**
 * Attainment and error budget for one window.
 *
 * `budgetTotal = (1 - objective) x total` and `remaining = 1 - bad / budgetTotal`,
 * exactly as F1 specifies. The budget is computed over the samples actually in
 * the window, so a calendar target mid-month has a budget proportional to the
 * month so far rather than to the month it has not had yet - which is what makes
 * the remaining figure mean the same thing on the 2nd and the 30th.
 *
 * **The remaining percentage is not clamped at zero.** An overspent budget
 * reports a negative number, because "0% remaining" and "you are four times over"
 * are different operational situations and a clamp would hide the second.
 */
export function computeBudget(verdict: SloVerdict, objectivePercent: number): SloBudget {
  if (verdict.total <= 0) {
    return { uptimePercent: null, budgetTotal: null, budgetConsumed: 0, budgetRemainingPercent: null };
  }

  const uptimePercent = (verdict.good / verdict.total) * 100;
  const allowedBadFraction = 1 - objectivePercent / 100;

  // A 100% objective allows no bad samples at all, so there is no budget to
  // express a percentage of. Reporting null rather than dividing by zero.
  if (allowedBadFraction <= 0) {
    return {
      uptimePercent,
      budgetTotal: 0,
      budgetConsumed: verdict.bad,
      budgetRemainingPercent: verdict.bad > 0 ? Number.NEGATIVE_INFINITY : 100,
    };
  }

  const budgetTotal = allowedBadFraction * verdict.total;
  return {
    uptimePercent,
    budgetTotal,
    budgetConsumed: verdict.bad,
    budgetRemainingPercent: (1 - verdict.bad / budgetTotal) * 100,
  };
}

/**
 * Burn rate over a window: how many times faster than sustainable the budget is
 * being spent.
 *
 * `(bad_W / total_W) / (1 - objective)`. 1.0 spends the budget exactly by the
 * end of the window; 14.4 spends a 30-day budget in about two days, which is why
 * that number appears in the classic fast-burn rule.
 *
 * Null when the window holds no verdicts. That is not a burn rate of zero: "no
 * samples" and "samples, all good" are different, and an alert rule must be able
 * to tell them apart rather than treating a dead probe as perfect health.
 */
export function burnRate(verdict: SloVerdict, objectivePercent: number): number | null {
  if (verdict.total <= 0) return null;
  const allowedBadFraction = 1 - objectivePercent / 100;
  if (allowedBadFraction <= 0) return verdict.bad > 0 ? Number.POSITIVE_INFINITY : 0;
  return verdict.bad / verdict.total / allowedBadFraction;
}

/**
 * Combines several monitors' verdicts into one, under a target's combination
 * mode.
 *
 * **WORST is not "the worst monitor's percentage".** It is per-sample: a scope is
 * good in a given slot only when every member was good in it. Implemented on
 * summed counts rather than per-timestamp, so it is an approximation - it pairs
 * the members' bad counts as if their outages never overlapped, which is the
 * conservative direction and the one an SLA should err in. Doing it exactly
 * would mean walking every monitor's buckets in lockstep at the finest grain, at
 * a cost the five-minute scheduler cannot carry for a page of fifty components.
 *
 * AVERAGE pools the members' counts, so every sample carries equal weight
 * regardless of which monitor produced it.
 */
export function combineVerdicts(verdicts: ReadonlyArray<SloVerdict>, combination: SloCombination): SloVerdict {
  if (verdicts.length === 0) return { good: 0, bad: 0, total: 0, excluded: 0 };
  if (verdicts.length === 1) return verdicts[0];

  const excluded = verdicts.reduce((sum, v) => sum + v.excluded, 0);

  if (combination === "AVERAGE") {
    const good = verdicts.reduce((sum, v) => sum + v.good, 0);
    const bad = verdicts.reduce((sum, v) => sum + v.bad, 0);
    return { good, bad, total: good + bad, excluded };
  }

  // WORST. The scope has as many slots as its busiest member reported, and a slot
  // is bad if any member was bad in it - approximated by summing bad counts and
  // capping at the slot count, so overlapping outages cannot push it past 100%.
  const total = Math.max(...verdicts.map((v) => v.total));
  if (total <= 0) return { good: 0, bad: 0, total: 0, excluded };
  const bad = Math.min(
    total,
    verdicts.reduce((sum, v) => sum + v.bad, 0),
  );
  return { good: total - bad, bad, total, excluded };
}

export interface SloWindowSpec {
  windowType: SloWindowType;
  windowDays: number | null;
  calendarPeriod: SloCalendarPeriod | null;
}

/**
 * The window a target is measured over, in UTC seconds, ending at `nowTs`.
 *
 * **UTC, and the admin UI says so.** `monitor_rollup_1d` is UTC-aligned by
 * definition, so a UTC calendar period is a plain sum of daily buckets. Giving
 * each target its own IANA zone would run into the :30 and :45 offsets the
 * rollup tables already document as unservable at the daily grain, and a target
 * silently measured over somebody else's month is worse than one honestly
 * labelled UTC.
 *
 * The returned window is the range actually *measured*: a calendar target
 * mid-period ends at now, not at the period's end. The period a row belongs to
 * is recoverable from its start, and reporting an end in the future would make
 * every count look like a shortfall.
 */
export function resolveWindow(spec: SloWindowSpec, nowTs: number): { start: number; end: number } {
  if (spec.windowType === "CALENDAR") {
    const d = new Date(nowTs * 1000);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    let start: number;
    if (spec.calendarPeriod === "YEAR") start = Date.UTC(year, 0, 1) / 1000;
    else if (spec.calendarPeriod === "QUARTER") start = Date.UTC(year, Math.floor(month / 3) * 3, 1) / 1000;
    else start = Date.UTC(year, month, 1) / 1000;
    return { start: Math.floor(start), end: nowTs };
  }

  const days = spec.windowDays && spec.windowDays > 0 ? spec.windowDays : 30;
  return { start: nowTs - days * DAY, end: nowTs };
}

/** A human label for the window, always naming UTC so nobody assumes otherwise. */
export function describeWindow(spec: SloWindowSpec): string {
  if (spec.windowType === "CALENDAR") {
    const period = spec.calendarPeriod ?? "MONTH";
    return `Calendar ${period.toLowerCase()} (UTC)`;
  }
  const days = spec.windowDays && spec.windowDays > 0 ? spec.windowDays : 30;
  return `Rolling ${days} days (UTC)`;
}
