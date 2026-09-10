import { describe, it, expect } from "vitest";
import { resolveReportRange, rollupToSloCounts, summariseCounts } from "./reportData.js";
import { emptySloCounts, type SloCounts } from "../services/slo.js";
import type { MonitorRollup } from "../types/db.js";

const HOUR = 3600;
const DAY = 86400;

function counts(overrides: Partial<SloCounts>): SloCounts {
  return { ...emptySloCounts(), ...overrides };
}

describe("resolveReportRange", () => {
  it("snaps both ends down to grain boundaries", () => {
    // 10:37 and 14:12 on an hourly grain are not bucket starts, and a report
    // whose label says 10:37 while its numbers start at 10:00 is a lie.
    const range = resolveReportRange(10 * HOUR + 2220, 14 * HOUR + 720, "1h", 100 * DAY);
    expect(range.from).toBe(10 * HOUR);
    expect(range.to).toBe(14 * HOUR);
    expect(range.clamped).toBe(false);
  });

  it("clamps the end back to the watermark and says that it did", () => {
    // Asked for 10 days, but the engine has only sealed 5.5.
    const watermark = 5 * DAY + HOUR * 12;
    const range = resolveReportRange(0, 10 * DAY, "1d", watermark);
    expect(range.to).toBe(5 * DAY);
    expect(range.requestedTo).toBe(10 * DAY);
    expect(range.clamped).toBe(true);
  });

  it("does not report a clamp when the watermark is past the request", () => {
    const range = resolveReportRange(0, 3 * DAY, "1d", 90 * DAY);
    expect(range.to).toBe(3 * DAY);
    expect(range.clamped).toBe(false);
  });

  it("never returns an end before its start", () => {
    // A range entirely in the unsealed future collapses to empty rather than
    // inverting, which would make `bucket_start >= from AND < to` match nothing
    // in one dialect and everything in another.
    const range = resolveReportRange(50 * DAY, 60 * DAY, "1d", 10 * DAY);
    expect(range.to).toBe(range.from);
    expect(range.to).toBeGreaterThanOrEqual(range.from);
    expect(range.clamped).toBe(true);
  });
});

describe("summariseCounts", () => {
  it("agrees with classify: maintenance excluded leaves the budget alone", () => {
    const summary = summariseCounts(
      counts({
        count_up: 50,
        count_down: 50,
        count_in_maint_window: 40,
        count_up_excl_maint: 50,
        count_down_excl_maint: 10,
      }),
      { excludeMaintenance: true, degradedCountsAsBad: false },
    );
    expect(summary.verdict).toEqual({ good: 50, bad: 10, total: 60, excluded: 40 });
    expect(summary.uptimePercent).toBeCloseTo((50 / 60) * 100, 9);
  });

  it("reports null rather than zero when nothing was measured", () => {
    // The difference the whole SLO module is careful about: "no samples" is not
    // "0% available", and a report that printed 0.000% for an unmonitored month
    // would be an accusation rather than a measurement.
    const summary = summariseCounts(emptySloCounts(), { excludeMaintenance: true, degradedCountsAsBad: false });
    expect(summary.uptimePercent).toBeNull();
    expect(summary.verdict.total).toBe(0);
  });

  it("moves degraded to the bad side only when the terms say so", () => {
    const base = counts({ count_up: 90, count_degraded: 10 });
    const lenient = summariseCounts(base, { excludeMaintenance: false, degradedCountsAsBad: false });
    const strict = summariseCounts(base, { excludeMaintenance: false, degradedCountsAsBad: true });
    expect(lenient.uptimePercent).toBeCloseTo(100, 9);
    expect(strict.uptimePercent).toBeCloseTo(90, 9);
  });
});

describe("rollupToSloCounts", () => {
  it("projects the eight fields classify reads and ignores the rest", () => {
    const row = {
      monitor_tag: "api",
      bucket_start: 0,
      count_total: 100,
      count_up: 80,
      count_down: 15,
      count_degraded: 5,
      count_maintenance: 0,
      count_no_data: 0,
      count_in_maint_window: 3,
      count_up_excl_maint: 78,
      count_down_excl_maint: 14,
      count_degraded_excl_maint: 5,
      latency_sum: 1234,
      latency_count: 100,
    } as unknown as MonitorRollup;

    expect(rollupToSloCounts(row)).toEqual({
      count_up: 80,
      count_down: 15,
      count_degraded: 5,
      count_maintenance: 0,
      count_in_maint_window: 3,
      count_up_excl_maint: 78,
      count_down_excl_maint: 14,
      count_degraded_excl_maint: 5,
    });
  });

  it("reads a missing column as zero rather than NaN", () => {
    // A row from a dialect or a migration state that does not carry every column
    // must not turn the whole report into NaN%, which is what `undefined + 1`
    // would do once it reached the arithmetic.
    const sparse = { monitor_tag: "api", count_up: 10 } as unknown as MonitorRollup;
    const projected = rollupToSloCounts(sparse);
    expect(projected.count_down).toBe(0);
    expect(Number.isNaN(projected.count_degraded)).toBe(false);
  });
});
