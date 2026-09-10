import { describe, it, expect } from "vitest";
import {
  DEFAULT_THRESHOLD,
  evaluateLatency,
  isMeasurable,
  parseThreshold,
  percentileOf,
  type LatencySample,
  type LatencyThreshold,
} from "./latencyThreshold.js";
import GC from "../../global-constants.js";

const rule = (over: Partial<LatencyThreshold> = {}): LatencyThreshold => ({
  ...DEFAULT_THRESHOLD,
  enabled: true,
  metric: "p95",
  window_minutes: 5,
  min_samples: 3,
  degraded_ms: 800,
  ...over,
});

const sample = (latency: number | null, over: Partial<LatencySample> = {}): LatencySample => ({
  timestamp: 0,
  status: GC.UP,
  type: GC.REALTIME,
  latency,
  ...over,
});

const window = (latencies: Array<number | null>) => latencies.map((l) => sample(l));

describe("percentileOf", () => {
  it("is exact, not bucketed", () => {
    // 100 values 1..100. An exact p95 is 95; the log-spaced histogram would
    // answer anywhere from about 79 to 119, which is why this does not use it.
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileOf(values, "p95")).toBe(95);
    expect(percentileOf(values, "p50")).toBe(50);
    expect(percentileOf(values, "p99")).toBe(99);
  });

  it("averages for avg", () => {
    expect(percentileOf([10, 20, 30], "avg")).toBe(20);
  });

  it("has no answer for an empty window", () => {
    expect(percentileOf([], "p95")).toBeNull();
  });
});

describe("isMeasurable", () => {
  /**
   * A timed-out request's latency is how long we waited before giving up, not
   * how long the service took. Counting it would let an outage inflate the
   * percentile and then be reported as mere slowness.
   */
  it("rejects timeouts and errors, whatever latency they carry", () => {
    expect(isMeasurable(sample(30000, { type: GC.TIMEOUT }))).toBe(false);
    expect(isMeasurable(sample(5000, { type: GC.ERROR }))).toBe(false);
  });

  it("rejects absent and non-positive latency", () => {
    expect(isMeasurable(sample(null))).toBe(false);
    expect(isMeasurable(sample(0))).toBe(false);
    expect(isMeasurable(sample(-1))).toBe(false);
  });

  it("accepts an ordinary measured check", () => {
    expect(isMeasurable(sample(120))).toBe(true);
  });
});

describe("evaluateLatency", () => {
  it("escalates UP to DEGRADED once the metric crosses", () => {
    const verdict = evaluateLatency(GC.UP, sample(900), window([850, 900, 950]), rule());
    expect(verdict?.status).toBe(GC.DEGRADED);
    expect(verdict?.reason).toContain("exceeds 800ms");
  });

  it("says nothing when the metric is under the threshold", () => {
    expect(evaluateLatency(GC.UP, sample(100), window([90, 100, 110]), rule())).toBeNull();
  });

  it("escalates to DOWN when down_ms is crossed, in preference to DEGRADED", () => {
    const verdict = evaluateLatency(GC.UP, sample(5000), window([5000, 5100, 5200]), rule({ down_ms: 3000 }));
    expect(verdict?.status).toBe(GC.DOWN);
  });

  it("cannot reach DOWN when down_ms is unset", () => {
    const verdict = evaluateLatency(GC.UP, sample(9999), window([9999, 9999, 9999]), rule({ down_ms: null }));
    expect(verdict?.status).toBe(GC.DEGRADED);
  });

  /**
   * Escalate only. The service said something worse than "slow", and slowness
   * must never argue it back down.
   */
  it("never softens a status the service itself reported", () => {
    const slow = window([9999, 9999, 9999]);
    expect(evaluateLatency(GC.DOWN, sample(9999), slow, rule())).toBeNull();
    expect(evaluateLatency(GC.DEGRADED, sample(9999), slow, rule())).toBeNull();
    expect(evaluateLatency(GC.NO_DATA, sample(9999), slow, rule())).toBeNull();
  });

  /**
   * min_samples exists so a monitor that just started cannot be flipped by one
   * slow check. Asserted at the boundary, both sides.
   */
  it("holds until min_samples measurable rows exist", () => {
    const r = rule({ min_samples: 3 });
    expect(evaluateLatency(GC.UP, sample(900), window([900, 900]), r)).toBeNull();
    expect(evaluateLatency(GC.UP, sample(900), window([900, 900, 900]), r)?.status).toBe(GC.DEGRADED);
  });

  /**
   * The count that matters is *measurable* samples, not rows. A window padded
   * with timeouts must not reach min_samples on their strength.
   */
  it("counts only measurable samples towards min_samples", () => {
    const padded = [sample(900), sample(30000, { type: GC.TIMEOUT }), sample(30000, { type: GC.TIMEOUT })];
    expect(evaluateLatency(GC.UP, sample(900), padded, rule({ min_samples: 3 }))).toBeNull();
  });

  it("ignores an unmeasurable current check even when the window is slow", () => {
    // The window says slow, but this minute produced no usable measurement, so
    // attributing the window's verdict to it would mislabel the wrong sample.
    expect(evaluateLatency(GC.UP, sample(null), window([900, 900, 900]), rule())).toBeNull();
  });

  it("explains itself in terms an operator configured", () => {
    const verdict = evaluateLatency(GC.UP, sample(812), window([800, 812, 820]), rule({ metric: "p95" }));
    expect(verdict?.reason).toBe("p95 820ms over 5m exceeds 800ms");
  });
});

describe("parseThreshold", () => {
  it("falls back per field, not wholesale", () => {
    // A stored object missing `metric` keeps its own degraded_ms rather than
    // being discarded, which would silently turn a configured rule off.
    const parsed = parseThreshold({ enabled: true, degraded_ms: 250 });
    expect(parsed.enabled).toBe(true);
    expect(parsed.degraded_ms).toBe(250);
    expect(parsed.metric).toBe(DEFAULT_THRESHOLD.metric);
  });

  it("treats a missing or unusable down_ms as null, not as the default", () => {
    // Null is meaningful here: "latency can never make this monitor DOWN".
    expect(parseThreshold({ enabled: true }).down_ms).toBeNull();
    expect(parseThreshold({ enabled: true, down_ms: 0 }).down_ms).toBeNull();
  });

  it("is off unless enabled is exactly true", () => {
    expect(parseThreshold({}).enabled).toBe(false);
    expect(parseThreshold({ enabled: "yes" }).enabled).toBe(false);
  });
});
