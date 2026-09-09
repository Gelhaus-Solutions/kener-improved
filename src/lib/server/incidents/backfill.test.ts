import { describe, it, expect } from "vitest";
import { estimateOverlayRows, MAX_BACKFILL_ROWS, MAX_BACKFILL_WINDOW_SECONDS } from "./backfill.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;

describe("estimateOverlayRows", () => {
  it("is one row per minute per component, inclusive of both ends", () => {
    expect(estimateOverlayRows(0, 9 * MINUTE, [{ monitor_tag: "a", component_impact: "MAJOR_OUTAGE" }])).toBe(10);
  });

  it("multiplies by the components", () => {
    const components = ["a", "b", "c"].map((monitor_tag) => ({ monitor_tag, component_impact: "MAJOR_OUTAGE" }));
    expect(estimateOverlayRows(0, 9 * MINUTE, components)).toBe(30);
  });

  it("counts an OPERATIONAL component as free", () => {
    // OPERATIONAL projects to no overlay row at all - writing UP would assert
    // health the monitors never reported - so counting it would make the cap
    // refuse imports that write far less than they claim.
    expect(estimateOverlayRows(0, 9 * MINUTE, [{ monitor_tag: "a", component_impact: "OPERATIONAL" }])).toBe(0);
  });

  it("counts the mix correctly", () => {
    expect(
      estimateOverlayRows(0, 9 * MINUTE, [
        { monitor_tag: "a", component_impact: "MAJOR_OUTAGE" },
        { monitor_tag: "b", component_impact: "OPERATIONAL" },
        { monitor_tag: "c", component_impact: "DEGRADED_PERFORMANCE" },
      ]),
    ).toBe(20);
  });

  it("is zero with no components", () => {
    // A global incident attaches nothing, so it writes no overlay: there is no
    // monitor whose timeline it would be.
    expect(estimateOverlayRows(0, 9 * MINUTE, [])).toBe(0);
  });

  it("is one row for a zero-length window", () => {
    expect(estimateOverlayRows(600, 600, [{ monitor_tag: "a", component_impact: "MAJOR_OUTAGE" }])).toBe(1);
  });
});

describe("the caps", () => {
  it("allows the full window for a single component", () => {
    // 90 days at one row a minute is ~130k rows, which is over the row cap. The
    // two limits are deliberately not consistent: the window catches a mistyped
    // year, the row count catches a wide import, and either alone lets the other
    // through.
    const single = estimateOverlayRows(0, MAX_BACKFILL_WINDOW_SECONDS, [
      { monitor_tag: "a", component_impact: "MAJOR_OUTAGE" },
    ]);
    expect(single).toBeGreaterThan(MAX_BACKFILL_ROWS);
  });

  it("lets a week across six components through the row cap", () => {
    const week = estimateOverlayRows(
      0,
      7 * 24 * HOUR,
      Array.from({ length: 6 }, (_, i) => ({ monitor_tag: `m${i}`, component_impact: "MAJOR_OUTAGE" })),
    );
    expect(week).toBeLessThan(MAX_BACKFILL_ROWS);
  });
});
