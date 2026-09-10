import type { SlaEvaluationRow } from "../db/repositories/sla.js";

/**
 * The multi-window burn-rate rule (F1b).
 *
 * Pure, like `slo.ts`, and for the same reason: this decides whether somebody
 * gets paged, and it should be testable by writing four numbers on a page.
 *
 * **Two windows, AND'd.** A single window fires on one bad five minutes. The
 * classic rule pairs a fast window with a slower confirmation - 1h at 14.4
 * together with 6h at 6 - so a brief spike has to still be visible over the
 * longer window before anyone is woken.
 */

/** The window keys `sla_evaluations` stores, matching `BURN_WINDOWS` in slo.ts. */
export type BurnWindowKey = "1h" | "6h" | "24h" | "3d";
export const BURN_WINDOW_KEYS: readonly BurnWindowKey[] = ["1h", "6h", "24h", "3d"];

export function isBurnWindowKey(value: unknown): value is BurnWindowKey {
  return typeof value === "string" && (BURN_WINDOW_KEYS as readonly string[]).includes(value);
}

/**
 * The classic fast-burn rule, and the defaults the admin form offers.
 *
 * 14.4 over an hour spends a 30-day budget in about two days; requiring 6 over
 * six hours as well is what stops a single bad five minutes from qualifying.
 */
export const DEFAULT_BURN_RULE: BurnRule = {
  windowA: "1h",
  thresholdA: 14.4,
  windowB: "6h",
  thresholdB: 6,
};

/** The slow-burn companion, offered as the other preset. */
export const SLOW_BURN_RULE: BurnRule = {
  windowA: "24h",
  thresholdA: 3,
  windowB: "3d",
  thresholdB: 1,
};

export interface BurnRule {
  windowA: BurnWindowKey;
  thresholdA: number;
  windowB: BurnWindowKey;
  thresholdB: number;
}

/**
 * What the rule says about an evaluation right now.
 *
 *   FIRING     both windows are at or above their thresholds
 *   RECOVERED  both windows are below them
 *   HOLD       neither can be concluded - see below
 */
export type BurnVerdict = "FIRING" | "RECOVERED" | "HOLD";

/** Reads one window's burn rate off a stored evaluation. */
export function burnFor(evaluation: SlaEvaluationRow, window: BurnWindowKey): number | null {
  if (window === "1h") return evaluation.burn_1h;
  if (window === "6h") return evaluation.burn_6h;
  if (window === "24h") return evaluation.burn_24h;
  return evaluation.burn_3d;
}

/**
 * Applies the rule.
 *
 * **A null burn rate holds, in both directions, and that asymmetry is the whole
 * point.** `burnRate` returns null for a window with no verdicts in it, which
 * means the checks stopped running - not that the service was healthy. Treating
 * null as zero would resolve every open burn alert the moment monitoring broke,
 * which is exactly when the alert should stay up. Treating it as a breach would
 * page on every new target before it has an hour of history. So it does neither.
 *
 * **A mixed reading holds too.** One window over and the other under is the
 * band between firing and recovering, and it is deliberate hysteresis: an alert
 * already open stays open, and one not yet open does not start. Without it a
 * burn rate hovering at the threshold would fire and resolve on alternating
 * five-minute ticks, and every one of those is a notification.
 */
export function evaluateBurnRule(evaluation: SlaEvaluationRow, rule: BurnRule): BurnVerdict {
  const a = burnFor(evaluation, rule.windowA);
  const b = burnFor(evaluation, rule.windowB);

  if (a === null || b === null) return "HOLD";

  if (a >= rule.thresholdA && b >= rule.thresholdB) return "FIRING";
  if (a < rule.thresholdA && b < rule.thresholdB) return "RECOVERED";
  return "HOLD";
}

/**
 * The rule a config carries, or null when it is not usable.
 *
 * Returns null rather than falling back to `DEFAULT_BURN_RULE`: a config with a
 * missing or misspelled window is a configuration mistake, and quietly
 * substituting the classic rule would mean somebody's carefully chosen
 * thresholds were silently replaced by numbers they never typed.
 */
export function ruleFromConfig(config: {
  burn_window_a: string | null;
  burn_threshold_a: number | null;
  burn_window_b: string | null;
  burn_threshold_b: number | null;
}): BurnRule | null {
  const { burn_window_a, burn_threshold_a, burn_window_b, burn_threshold_b } = config;
  if (!isBurnWindowKey(burn_window_a) || !isBurnWindowKey(burn_window_b)) return null;
  if (typeof burn_threshold_a !== "number" || !Number.isFinite(burn_threshold_a)) return null;
  if (typeof burn_threshold_b !== "number" || !Number.isFinite(burn_threshold_b)) return null;
  return {
    windowA: burn_window_a,
    thresholdA: burn_threshold_a,
    windowB: burn_window_b,
    thresholdB: burn_threshold_b,
  };
}

/** A human phrase for a fired rule, used in the alert description and incident body. */
export function describeBurnRule(rule: BurnRule, evaluation: SlaEvaluationRow): string {
  const a = burnFor(evaluation, rule.windowA);
  const b = burnFor(evaluation, rule.windowB);
  const fmt = (v: number | null) => (v === null ? "no data" : `${v.toFixed(2)}x`);
  return (
    `burn rate ${fmt(a)} over ${rule.windowA} (threshold ${rule.thresholdA}x) ` +
    `and ${fmt(b)} over ${rule.windowB} (threshold ${rule.thresholdB}x)`
  );
}
