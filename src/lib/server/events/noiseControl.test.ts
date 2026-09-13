import { describe, it, expect } from "vitest";
import {
  MAX_BATCH_WINDOW_SECONDS,
  batchWindowEnd,
  ceilingDelayUntil,
  hasNoisePolicy,
  nextAttemptAt,
  normaliseBatchWindow,
  normaliseMaxPerMinute,
} from "./noiseControl.js";

/**
 * E11 part 4. When a delivery is allowed out.
 *
 * **The property that matters most is that nothing is ever dropped.** Both knobs
 * postpone. An outbound delivery log is an evidence trail, so an event that
 * disappeared because a counter was high would be indistinguishable from a relay
 * bug, which is the failure this subsystem exists to avoid. Every assertion here
 * is about a TIME, never about a decision to discard.
 */

describe("the batch window is a shared grid, not a per-event timer", () => {
  // THE POINT OF THE WHOLE FEATURE. Per-event windows would give five events
  // arriving a second apart five deadlines a second apart, which is exactly the
  // behaviour being fixed. A shared boundary makes them due together, so one
  // request collects all five.
  it("gives every event in the same window the same deadline", () => {
    const window = 60;
    const deadlines = [1768485603, 1768485621, 1768485644, 1768485659].map((t) => batchWindowEnd(t, window));
    expect(new Set(deadlines).size).toBe(1);
    expect(deadlines[0]).toBe(1768485660);
  });

  it("puts an event just after a boundary into the next window, not the same one", () => {
    expect(batchWindowEnd(1768485660, 60)).toBe(1768485720);
    expect(batchWindowEnd(1768485661, 60)).toBe(1768485720);
  });

  // An event landing exactly on a grid line belongs to the window opening, not
  // the one that just closed and may already have been swept.
  it("never returns a deadline in the past", () => {
    for (const now of [1768485600, 1768485601, 1768485659, 1768485660]) {
      expect(batchWindowEnd(now, 60)).toBeGreaterThan(now);
    }
  });

  it("clamps an absurd window rather than honouring it", () => {
    const end = batchWindowEnd(1768485600, 999999);
    expect(end - 1768485600).toBeLessThanOrEqual(MAX_BATCH_WINDOW_SECONDS);
  });

  it("treats a zero or negative window as no batching", () => {
    expect(batchWindowEnd(1768485600, 0)).toBe(1768485600);
    expect(batchWindowEnd(1768485600, -30)).toBe(1768485600);
  });
});

describe("the ceiling postpones and never discards", () => {
  it("is due now while under the ceiling", () => {
    expect(ceilingDelayUntil(1768485600, 5, 0, null)).toBe(1768485600);
    expect(ceilingDelayUntil(1768485600, 5, 4, 1768485570)).toBe(1768485600);
  });

  // At the ceiling it waits for the oldest attempt to age out of the trailing
  // minute, which is a TIME rather than a refusal.
  it("waits for the oldest recent attempt to fall out of the window", () => {
    const now = 1768485600;
    const oldest = 1768485570; // 30s ago
    expect(ceilingDelayUntil(now, 5, 5, oldest)).toBe(oldest + 61);
  });

  it("waits a whole minute when it cannot tell when the window frees", () => {
    expect(ceilingDelayUntil(1768485600, 5, 5, null)).toBe(1768485660);
  });

  it("never returns a time in the past even for a very old attempt", () => {
    const now = 1768485600;
    expect(ceilingDelayUntil(now, 5, 5, now - 5000)).toBe(now);
  });

  it("ignores a nonsensical ceiling rather than throttling everything", () => {
    expect(ceilingDelayUntil(1768485600, 0, 99, null)).toBe(1768485600);
    expect(ceilingDelayUntil(1768485600, -3, 99, null)).toBe(1768485600);
  });
});

describe("the two rules are floors, so the later one wins", () => {
  const now = 1768485600;

  it("takes the window when the window is later", () => {
    const due = nextAttemptAt(now, { batchWindowSeconds: 300, maxPerMinute: 10 }, 0, null);
    expect(due).toBe(batchWindowEnd(now, 300));
  });

  // Taking the earlier of the two would let one knob silently defeat the other,
  // which is the kind of bug that presents as "the ceiling does not work".
  it("takes the ceiling when the ceiling is later", () => {
    const oldest = now - 1;
    const due = nextAttemptAt(now, { batchWindowSeconds: 5, maxPerMinute: 2 }, 2, oldest);
    expect(due).toBe(oldest + 61);
    expect(due).toBeGreaterThan(batchWindowEnd(now, 5));
  });

  it("is due immediately when neither knob is set", () => {
    expect(nextAttemptAt(now, { batchWindowSeconds: null, maxPerMinute: null }, 999, null)).toBe(now);
  });
});

describe("an endpoint with no policy is untouched", () => {
  it("reports no policy for the default endpoint", () => {
    expect(hasNoisePolicy({ batchWindowSeconds: null, maxPerMinute: null })).toBe(false);
    expect(hasNoisePolicy({ batchWindowSeconds: 0, maxPerMinute: 0 })).toBe(false);
  });

  it("reports a policy when either knob is set", () => {
    expect(hasNoisePolicy({ batchWindowSeconds: 30, maxPerMinute: null })).toBe(true);
    expect(hasNoisePolicy({ batchWindowSeconds: null, maxPerMinute: 5 })).toBe(true);
  });
});

describe("operator input is clamped rather than trusted", () => {
  it("reads an absent or empty value as off", () => {
    for (const value of [undefined, null, "", 0, -1, "abc", NaN]) {
      expect(normaliseBatchWindow(value)).toBeNull();
    }
    for (const value of [undefined, null, "", 0, -1, "abc", NaN]) {
      expect(normaliseMaxPerMinute(value)).toBeNull();
    }
  });

  it("caps a window at the maximum", () => {
    expect(normaliseBatchWindow(999999)).toBe(MAX_BATCH_WINDOW_SECONDS);
    expect(normaliseBatchWindow("60")).toBe(60);
  });

  it("keeps a sensible ceiling", () => {
    expect(normaliseMaxPerMinute("10")).toBe(10);
    expect(normaliseMaxPerMinute(1)).toBe(1);
  });
});
