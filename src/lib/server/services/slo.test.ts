import { describe, it, expect } from "vitest";
import {
  burnRate,
  classify,
  combineVerdicts,
  computeBudget,
  describeWindow,
  emptySloCounts,
  resolveWindow,
  type SloCounts,
} from "./slo.js";

function counts(overrides: Partial<SloCounts>): SloCounts {
  return { ...emptySloCounts(), ...overrides };
}

describe("classify", () => {
  it("counts maintenance as good when maintenance is not excluded", () => {
    const verdict = classify(counts({ count_up: 90, count_down: 5, count_maintenance: 5 }), {
      excludeMaintenance: false,
      degradedCountsAsBad: false,
    });
    expect(verdict).toEqual({ good: 95, bad: 5, total: 100, excluded: 0 });
  });

  it("reads the excl_maint columns and reports what was excluded", () => {
    const verdict = classify(
      counts({
        count_up: 90,
        count_down: 5,
        count_maintenance: 5,
        count_in_maint_window: 5,
        count_up_excl_maint: 90,
        count_down_excl_maint: 5,
      }),
      { excludeMaintenance: true, degradedCountsAsBad: false },
    );
    expect(verdict).toEqual({ good: 90, bad: 5, total: 95, excluded: 5 });
  });

  it("moves degraded from good to bad when the target says so", () => {
    const input = counts({ count_up: 80, count_degraded: 15, count_down: 5 });
    expect(classify(input, { excludeMaintenance: false, degradedCountsAsBad: false })).toMatchObject({
      good: 95,
      bad: 5,
    });
    expect(classify(input, { excludeMaintenance: false, degradedCountsAsBad: true })).toMatchObject({
      good: 80,
      bad: 20,
    });
  });

  /**
   * The property the denominator exists to protect. A monitor that recorded
   * nothing for half the window must not be charged for it: NO_DATA is the
   * monitoring system's own gap, not the service's breach.
   */
  it("leaves NO_DATA out of both sides, so gaps do not spend the budget", () => {
    // 50 up, 50 no-data. NO_DATA appears in no count_* field this reads, which
    // is exactly the point: total is 50, not 100, and uptime is 100%.
    const verdict = classify(counts({ count_up: 50 }), {
      excludeMaintenance: false,
      degradedCountsAsBad: false,
    });
    expect(verdict.total).toBe(50);
    expect(computeBudget(verdict, 99.9).uptimePercent).toBe(100);
  });
});

describe("computeBudget", () => {
  it("computes attainment and the budget from the objective", () => {
    // 1000 samples, 99.9% objective: the budget is exactly 1 bad sample.
    const budget = computeBudget({ good: 999, bad: 1, total: 1000, excluded: 0 }, 99.9);
    expect(budget.uptimePercent).toBeCloseTo(99.9, 6);
    expect(budget.budgetTotal).toBeCloseTo(1, 6);
    expect(budget.budgetConsumed).toBe(1);
    expect(budget.budgetRemainingPercent).toBeCloseTo(0, 6);
  });

  it("reports a negative remaining budget rather than clamping at zero", () => {
    // Four times the allowance spent. "0%" and "four times over" are different
    // operational situations and the clamp would hide the second.
    const budget = computeBudget({ good: 996, bad: 4, total: 1000, excluded: 0 }, 99.9);
    expect(budget.budgetRemainingPercent).toBeCloseTo(-300, 6);
  });

  it("has no percentages to report for an empty window", () => {
    const budget = computeBudget({ good: 0, bad: 0, total: 0, excluded: 0 }, 99.9);
    expect(budget.uptimePercent).toBeNull();
    expect(budget.budgetRemainingPercent).toBeNull();
  });
});

describe("burnRate", () => {
  /**
   * The two numbers the classic multi-window rule is written in terms of. If
   * these drift, every fast-burn alert drifts with them.
   */
  it("is 1.0 when the window spends exactly its share", () => {
    // 99.9% allows 0.1% bad. A window that is 0.1% bad burns at exactly 1.0.
    expect(burnRate({ good: 999, bad: 1, total: 1000, excluded: 0 }, 99.9)).toBeCloseTo(1, 6);
  });

  it("is 14.4 when a 30-day budget would be gone in about two days", () => {
    // 14.4 x 0.1% = 1.44% bad.
    expect(burnRate({ good: 9856, bad: 144, total: 10000, excluded: 0 }, 99.9)).toBeCloseTo(14.4, 6);
  });

  it("is null, not zero, for a window with no verdicts", () => {
    // A dead probe and a perfectly healthy service must not look identical to an
    // alert rule.
    expect(burnRate({ good: 0, bad: 0, total: 0, excluded: 0 }, 99.9)).toBeNull();
    expect(burnRate({ good: 100, bad: 0, total: 100, excluded: 0 }, 99.9)).toBe(0);
  });
});

describe("combineVerdicts", () => {
  it("pools the counts under AVERAGE", () => {
    const combined = combineVerdicts(
      [
        { good: 100, bad: 0, total: 100, excluded: 0 },
        { good: 50, bad: 50, total: 100, excluded: 0 },
      ],
      "AVERAGE",
    );
    expect(combined).toMatchObject({ good: 150, bad: 50, total: 200 });
    expect(computeBudget(combined, 99.9).uptimePercent).toBeCloseTo(75, 6);
  });

  it("charges the scope for any member's bad samples under WORST", () => {
    // One perfect component cannot rescue the page: the scope is as bad as the
    // union of its members' bad slots.
    const combined = combineVerdicts(
      [
        { good: 100, bad: 0, total: 100, excluded: 0 },
        { good: 50, bad: 50, total: 100, excluded: 0 },
      ],
      "WORST",
    );
    expect(combined).toMatchObject({ good: 50, bad: 50, total: 100 });
  });

  it("cannot report worse than fully down when members' outages overlap", () => {
    // Three members each bad for the whole window. Summing bad counts would give
    // 300 bad out of 100 slots; the cap is what keeps uptime at 0 rather than
    // at minus 200 percent.
    const combined = combineVerdicts(
      [
        { good: 0, bad: 100, total: 100, excluded: 0 },
        { good: 0, bad: 100, total: 100, excluded: 0 },
        { good: 0, bad: 100, total: 100, excluded: 0 },
      ],
      "WORST",
    );
    expect(combined).toMatchObject({ good: 0, bad: 100, total: 100 });
    expect(computeBudget(combined, 99.9).uptimePercent).toBe(0);
  });

  it("keeps a single member's verdict untouched under either mode", () => {
    const only = { good: 90, bad: 10, total: 100, excluded: 3 };
    expect(combineVerdicts([only], "WORST")).toEqual(only);
    expect(combineVerdicts([only], "AVERAGE")).toEqual(only);
  });
});

describe("resolveWindow", () => {
  // 2026-09-10T17:00:00Z, deliberately mid-month and mid-quarter.
  const now = Math.floor(Date.UTC(2026, 8, 10, 17, 0, 0) / 1000);

  it("walks back the requested number of days for a rolling window", () => {
    const window = resolveWindow({ windowType: "ROLLING", windowDays: 30, calendarPeriod: null }, now);
    expect(window.end).toBe(now);
    expect(now - window.start).toBe(30 * 86400);
  });

  it("starts a calendar month at the first of the month, in UTC", () => {
    const window = resolveWindow({ windowType: "CALENDAR", windowDays: null, calendarPeriod: "MONTH" }, now);
    expect(window.start).toBe(Math.floor(Date.UTC(2026, 8, 1) / 1000));
    // The measured window ends now, not at the month's end: reporting an end in
    // the future would make every count look like a shortfall.
    expect(window.end).toBe(now);
  });

  it("starts a quarter at the first month of that quarter", () => {
    // September is in Q3, which begins in July.
    const window = resolveWindow({ windowType: "CALENDAR", windowDays: null, calendarPeriod: "QUARTER" }, now);
    expect(window.start).toBe(Math.floor(Date.UTC(2026, 6, 1) / 1000));
  });

  it("starts a year on 1 January", () => {
    const window = resolveWindow({ windowType: "CALENDAR", windowDays: null, calendarPeriod: "YEAR" }, now);
    expect(window.start).toBe(Math.floor(Date.UTC(2026, 0, 1) / 1000));
  });

  it("names UTC in every window description", () => {
    expect(describeWindow({ windowType: "ROLLING", windowDays: 30, calendarPeriod: null })).toContain("UTC");
    expect(describeWindow({ windowType: "CALENDAR", windowDays: null, calendarPeriod: "MONTH" })).toContain("UTC");
  });
});
