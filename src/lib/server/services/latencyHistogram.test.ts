import { describe, it, expect } from "vitest";
import {
  HISTOGRAM_BUCKETS,
  HISTOGRAM_GROWTH,
  HISTOGRAM_MAX_MS,
  bucketBounds,
  bucketIndexFor,
  decodeHistogram,
  emptyHistogram,
  encodeHistogram,
  histogramCount,
  histogramFromLatencies,
  histogramPercentiles,
  histogramQuantile,
  mergeHistograms,
  recordLatency,
} from "./latencyHistogram.js";

/**
 * The exact percentile of a sample set, by nearest rank.
 *
 * This is the thing the histogram is approximating, computed the slow honest way
 * over every sample. Comparing against it is F6a's acceptance criterion, and it
 * is the only comparison that means anything: a histogram checked only against
 * itself would agree with its own mistakes.
 */
function bruteForceQuantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error("no samples");
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Deterministic pseudo-random, so a failure is reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("latency histogram bucketing", () => {
  it("puts everything at or below the base in bucket 0", () => {
    expect(bucketIndexFor(0)).toBe(0);
    expect(bucketIndexFor(-5)).toBe(0);
    expect(bucketIndexFor(0.4)).toBe(0);
    expect(bucketIndexFor(1)).toBe(0);
  });

  it("saturates rather than overflowing", () => {
    expect(bucketIndexFor(HISTOGRAM_MAX_MS * 100)).toBe(HISTOGRAM_BUCKETS - 1);
    expect(bucketIndexFor(Number.POSITIVE_INFINITY)).toBe(0);
    expect(bucketIndexFor(Number.NaN)).toBe(0);
  });

  it("advances one bucket per growth factor", () => {
    // Nudged off the boundary: 1.2^n computed by repeated multiplication and by
    // Math.pow do not always land on the same float, and a value sitting exactly
    // on a bucket edge is the one case where either answer is defensible.
    for (let i = 1; i < 20; i++) {
      expect(bucketIndexFor(Math.pow(HISTOGRAM_GROWTH, i) * 1.0001)).toBe(i);
    }
  });

  it("gives bucket 0 a floor of zero, since it holds zero-latency samples", () => {
    expect(bucketBounds(0).lo).toBe(0);
    expect(bucketBounds(1).lo).toBeGreaterThan(0);
  });

  it("bounds are contiguous", () => {
    for (let i = 1; i < HISTOGRAM_BUCKETS - 1; i++) {
      expect(bucketBounds(i).hi).toBeCloseTo(bucketBounds(i + 1).lo, 6);
    }
  });
});

describe("latency histogram encoding", () => {
  it("round-trips", () => {
    const original = histogramFromLatencies([1, 5, 5, 12, 900, 40000]);
    const decoded = decodeHistogram(encodeHistogram(original));
    expect([...decoded.entries()].sort()).toEqual([...original.entries()].sort());
    expect(histogramCount(decoded)).toBe(6);
  });

  it("encodes an empty histogram as null, not as an empty object", () => {
    expect(encodeHistogram(emptyHistogram())).toBeNull();
  });

  it("is deterministic regardless of insertion order", () => {
    const a = emptyHistogram();
    recordLatency(a, 900);
    recordLatency(a, 5);
    recordLatency(a, 40);
    const b = emptyHistogram();
    recordLatency(b, 40);
    recordLatency(b, 900);
    recordLatency(b, 5);
    expect(encodeHistogram(a)).toBe(encodeHistogram(b));
  });

  it("decodes junk to an empty histogram instead of throwing", () => {
    // This is read while rendering a page. A corrupt column should cost a
    // latency number, not the request.
    for (const junk of [null, undefined, "", "not json", "[1,2,3]", '"a string"', "42"]) {
      expect(histogramCount(decodeHistogram(junk as string | null))).toBe(0);
    }
  });

  it("drops out-of-range indexes and non-positive counts", () => {
    const decoded = decodeHistogram(JSON.stringify({ "-1": 5, "999": 5, "3": -2, "4": 0, "5": 7 }));
    expect([...decoded.entries()]).toEqual([[5, 7]]);
  });
});

describe("latency histogram merging", () => {
  it("is exactly equivalent to recording every sample into one histogram", () => {
    // The property the whole design rests on. If this drifts, every folded
    // rollup and every 90-day bar is quietly wrong.
    const random = seeded(20260910);
    const parts: number[][] = [];
    for (let p = 0; p < 12; p++) {
      parts.push(Array.from({ length: 50 }, () => Math.floor(random() * 3000) + 1));
    }
    const merged = mergeHistograms(...parts.map((values) => histogramFromLatencies(values)));
    const direct = histogramFromLatencies(parts.flat());
    expect(encodeHistogram(merged)).toBe(encodeHistogram(direct));
  });

  it("ignores null and undefined members", () => {
    const merged = mergeHistograms(histogramFromLatencies([10, 20]), null, undefined);
    expect(histogramCount(merged)).toBe(2);
  });

  it("merging nothing yields an empty histogram", () => {
    expect(histogramCount(mergeHistograms())).toBe(0);
  });
});

describe("latency histogram quantiles against brute force", () => {
  const distributions: Array<{ name: string; sample: (random: () => number) => number }> = [
    { name: "uniform 1-2000ms", sample: (r) => 1 + r() * 2000 },
    { name: "lognormal around 120ms", sample: (r) => Math.exp(Math.log(120) + (r() - 0.5) * 2) },
    // The one that matters in practice: almost everything fast, a thin slow tail.
    { name: "fast with a slow tail", sample: (r) => (r() < 0.97 ? 20 + r() * 40 : 2000 + r() * 8000) },
    { name: "bimodal 30ms and 800ms", sample: (r) => (r() < 0.5 ? 28 + r() * 6 : 780 + r() * 50) },
    { name: "constant 250ms", sample: () => 250 },
  ];

  for (const distribution of distributions) {
    it(`is within one bucket width for ${distribution.name}`, () => {
      const random = seeded(4242);
      const values = Array.from({ length: 5000 }, () => distribution.sample(random));
      const histogram = histogramFromLatencies(values);

      let worst = 0;
      for (const q of [0.5, 0.75, 0.9, 0.95, 0.99]) {
        const exact = bruteForceQuantile(values, q);
        const estimate = histogramQuantile(histogram, q);
        expect(estimate).not.toBeNull();
        const error = Math.abs((estimate as number) - exact) / exact;
        worst = Math.max(worst, error);
      }
      // One bucket is 20% wide, and interpolation keeps the answer inside the
      // bucket holding the true value, so the error cannot exceed that.
      expect(worst).toBeLessThanOrEqual(0.2);
    });
  }

  it("gives the same answer merged as unmerged, which is what a 90-day bar does", () => {
    const random = seeded(777);
    const days: number[][] = [];
    for (let d = 0; d < 90; d++) {
      days.push(Array.from({ length: 288 }, () => 40 + random() * 160));
    }
    const perDay = days.map((values) => histogramFromLatencies(values));
    const merged = mergeHistograms(...perDay);
    const allValues = days.flat();

    for (const q of [0.5, 0.9, 0.95, 0.99]) {
      const exact = bruteForceQuantile(allValues, q);
      const estimate = histogramQuantile(merged, q) as number;
      expect(Math.abs(estimate - exact) / exact).toBeLessThanOrEqual(0.2);
    }
  });

  it("beats averaging per-day percentiles, which is the alternative it exists to avoid", () => {
    // The failure mode is specifically a *few bad days among many good ones*.
    // Ninety days drawn from one distribution would let the naive average look
    // fine, which is exactly how this mistake survives review: it is close
    // enough to right whenever nothing interesting happened.
    const random = seeded(31337);
    const days: number[][] = [];
    for (let d = 0; d < 90; d++) {
      const bad = d >= 40 && d < 43;
      days.push(Array.from({ length: 288 }, () => (bad ? 1800 + random() * 900 : 40 + random() * 30)));
    }
    const perDay = days.map((values) => histogramFromLatencies(values));
    const merged = mergeHistograms(...perDay);
    const allValues = days.flat();

    const trueP99 = bruteForceQuantile(allValues, 0.99);
    const mergedP99 = histogramQuantile(merged, 0.99) as number;
    const averagedP99 =
      perDay.reduce((sum, histogram) => sum + (histogramQuantile(histogram, 0.99) as number), 0) / perDay.length;

    // The three bad days are 3.3% of the samples, so the real p99 is in the slow
    // mode. Merging finds it; averaging the ninety daily p99s is dominated by
    // the eighty-seven quiet ones and reports a number no probe ever saw.
    expect(trueP99).toBeGreaterThan(1000);
    expect(Math.abs(mergedP99 - trueP99) / trueP99).toBeLessThanOrEqual(0.2);
    expect(averagedP99).toBeLessThan(trueP99 / 2);
  });

  it("saturates at the top bucket instead of reporting an impossible latency", () => {
    const histogram = histogramFromLatencies([HISTOGRAM_MAX_MS * 5, HISTOGRAM_MAX_MS * 9]);
    const p99 = histogramQuantile(histogram, 0.99) as number;
    expect(p99).toBeLessThanOrEqual(HISTOGRAM_MAX_MS);
    expect(p99).toBeGreaterThan(HISTOGRAM_MAX_MS * 0.8);
  });

  it("returns null for an empty histogram rather than zero", () => {
    // Zero would be indistinguishable from a monitor that answered instantly.
    const percentiles = histogramPercentiles(emptyHistogram());
    expect(percentiles).toEqual({ p50: null, p90: null, p95: null, p99: null });
  });

  it("clamps quantiles outside 0..1", () => {
    const histogram = histogramFromLatencies([100, 200, 300]);
    expect(histogramQuantile(histogram, -1)).toBe(histogramQuantile(histogram, 0));
    expect(histogramQuantile(histogram, 5)).toBe(histogramQuantile(histogram, 1));
  });

  it("orders the four materialized percentiles", () => {
    const random = seeded(9);
    const histogram = histogramFromLatencies(Array.from({ length: 2000 }, () => 10 + random() * 990));
    const { p50, p90, p95, p99 } = histogramPercentiles(histogram);
    expect(p50).toBeLessThanOrEqual(p90 as number);
    expect(p90).toBeLessThanOrEqual(p95 as number);
    expect(p95).toBeLessThanOrEqual(p99 as number);
  });
});
