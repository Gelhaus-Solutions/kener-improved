import { describe, it, expect } from "vitest";
import { DEFAULT_BURN_RULE, SLOW_BURN_RULE, evaluateBurnRule, ruleFromConfig } from "./sloBurnAlert.js";
import type { SlaEvaluationRow } from "../db/repositories/sla.js";

function evaluation(burns: Partial<Pick<SlaEvaluationRow, "burn_1h" | "burn_6h" | "burn_24h" | "burn_3d">>) {
  return {
    sla_target_id: 1,
    window_start: 0,
    window_end: 0,
    count_total: 100,
    count_good: 100,
    count_bad: 0,
    count_excluded: 0,
    uptime_percent: 100,
    objective_percent: 99.9,
    budget_total: 0.1,
    budget_consumed: 0,
    budget_remaining_percent: 100,
    burn_1h: null,
    burn_6h: null,
    burn_24h: null,
    burn_3d: null,
    monitor_count: 1,
    computed_at: 0,
    ...burns,
  } satisfies SlaEvaluationRow;
}

describe("evaluateBurnRule", () => {
  it("fires only when both windows are at or above their thresholds", () => {
    // The classic rule: 1h at 14.4 AND 6h at 6.
    expect(evaluateBurnRule(evaluation({ burn_1h: 20, burn_6h: 8 }), DEFAULT_BURN_RULE)).toBe("FIRING");
    // Exactly at the thresholds still fires - "at or above".
    expect(evaluateBurnRule(evaluation({ burn_1h: 14.4, burn_6h: 6 }), DEFAULT_BURN_RULE)).toBe("FIRING");
  });

  it("recovers only when both windows are below", () => {
    expect(evaluateBurnRule(evaluation({ burn_1h: 1, burn_6h: 1 }), DEFAULT_BURN_RULE)).toBe("RECOVERED");
  });

  /**
   * The property that stops a spike paging somebody. A single very bad hour
   * pushes 1h over 14.4 long before 6h can reach 6, and the rule must not fire
   * on that alone.
   */
  it("does not fire on a fast window alone", () => {
    expect(evaluateBurnRule(evaluation({ burn_1h: 50, burn_6h: 2 }), DEFAULT_BURN_RULE)).toBe("HOLD");
  });

  /**
   * Hysteresis. Between firing and recovering nothing happens, so an alert
   * already open stays open and one not open does not start. Without this a burn
   * rate hovering at the threshold notifies on alternating five-minute ticks.
   */
  it("holds in the band between firing and recovering", () => {
    // 1h has dropped below, 6h is still elevated: neither conclusion.
    expect(evaluateBurnRule(evaluation({ burn_1h: 2, burn_6h: 9 }), DEFAULT_BURN_RULE)).toBe("HOLD");
  });

  /**
   * The asymmetry that matters most. A window with no verdicts means the checks
   * stopped running, not that the service was healthy.
   */
  it("holds when a window has no data, rather than resolving", () => {
    // An alert is open and monitoring dies. Treating null as zero would resolve
    // it, which is precisely backwards.
    expect(evaluateBurnRule(evaluation({ burn_1h: null, burn_6h: null }), DEFAULT_BURN_RULE)).toBe("HOLD");
    expect(evaluateBurnRule(evaluation({ burn_1h: 50, burn_6h: null }), DEFAULT_BURN_RULE)).toBe("HOLD");
  });

  it("does not fire for a brand new target with no history", () => {
    // Nothing has been measured over either window yet.
    expect(evaluateBurnRule(evaluation({}), DEFAULT_BURN_RULE)).toBe("HOLD");
  });

  it("reads the windows the rule names, not fixed ones", () => {
    // The slow rule looks at 24h and 3d. A fixture that is wild on 1h/6h and
    // calm on 24h/3d must recover under it, which only holds if the rule's own
    // window keys are used.
    const row = evaluation({ burn_1h: 99, burn_6h: 99, burn_24h: 0.5, burn_3d: 0.2 });
    expect(evaluateBurnRule(row, SLOW_BURN_RULE)).toBe("RECOVERED");
    expect(evaluateBurnRule(row, DEFAULT_BURN_RULE)).toBe("FIRING");
  });
});

describe("ruleFromConfig", () => {
  it("reads a well-formed config", () => {
    expect(
      ruleFromConfig({ burn_window_a: "1h", burn_threshold_a: 14.4, burn_window_b: "6h", burn_threshold_b: 6 }),
    ).toEqual(DEFAULT_BURN_RULE);
  });

  it("refuses a config rather than substituting the default", () => {
    // Silently falling back would replace somebody's chosen thresholds with
    // numbers they never typed, and the alert would look configured.
    expect(
      ruleFromConfig({ burn_window_a: "2h", burn_threshold_a: 14.4, burn_window_b: "6h", burn_threshold_b: 6 }),
    ).toBeNull();
    expect(
      ruleFromConfig({ burn_window_a: "1h", burn_threshold_a: null, burn_window_b: "6h", burn_threshold_b: 6 }),
    ).toBeNull();
    expect(
      ruleFromConfig({ burn_window_a: null, burn_threshold_a: 1, burn_window_b: null, burn_threshold_b: 1 }),
    ).toBeNull();
  });
});
