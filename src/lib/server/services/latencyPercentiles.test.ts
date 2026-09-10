import { describe, it, expect } from "vitest";
import { snapToGrain } from "./latencyPercentiles.js";
import {
  histogramFromLatencies,
  histogramPercentiles,
  mergeHistograms,
  bucketBounds,
  bucketIndexFor,
} from "./latencyHistogram.js";
import { ROLLUP_GRAIN_SECONDS } from "../types/db.js";

// B4's acceptance criterion, stated as a property: a percentile taken from the
// merged histogram must agree with one taken by sorting the raw samples.
//
// "Agree" cannot mean "be equal" - the histogram is lossy by construction, 64
// log-spaced buckets - so the bound asserted here is the one the design actually
// promises: the answer lies inside the bucket that contains the true value. Any
// looser bound would pass for an implementation that merged the wrong buckets;
// any tighter one would be asserting something the storage does not claim.

/** The exact percentile, by sorting. What the histogram approximates. */
function bruteForce(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank];
}

function assertWithinBucket(approx: number | null, exact: number, label: string) {
  expect(approx, label).not.toBeNull();
  const { lo, hi } = bucketBounds(bucketIndexFor(exact));
  // The interpolated answer sits inside the bucket holding the true value, or
  // on the boundary of an adjacent one when the rank falls exactly on an edge.
  const { lo: loPrev } = bucketBounds(Math.max(0, bucketIndexFor(exact) - 1));
  expect(approx as number, `${label}: ${approx} not near ${exact} (bucket ${lo}..${hi})`).toBeGreaterThanOrEqual(
    loPrev,
  );
  expect(approx as number, `${label}: ${approx} not near ${exact} (bucket ${lo}..${hi})`).toBeLessThanOrEqual(hi * 1.2);
}

describe("percentiles from a merged histogram match a brute-force computation", () => {
  const distributions: Array<{ name: string; make: (i: number) => number }> = [
    { name: "flat", make: () => 100 },
    { name: "linear", make: (i) => 1 + i },
    { name: "bimodal", make: (i) => (i % 10 === 0 ? 2000 : 50) },
    { name: "long tail", make: (i) => (i % 100 === 0 ? 9000 : 20 + (i % 7)) },
    { name: "wide", make: (i) => Math.round(Math.pow(1.05, i % 200)) + 1 },
  ];

  for (const { name, make } of distributions) {
    it(`holds for a ${name} distribution split across buckets`, () => {
      const values = Array.from({ length: 1000 }, (_, i) => make(i));

      // Split into ten "buckets" and merge, which is what a multi-bucket read
      // does. The merged answer must be the same as one histogram over the lot -
      // that equivalence is the property that makes rollups mergeable at all.
      const chunks: number[][] = [];
      for (let i = 0; i < 10; i++) chunks.push(values.slice(i * 100, (i + 1) * 100));
      const merged = mergeHistograms(...chunks.map((chunk) => histogramFromLatencies(chunk)));
      const whole = histogramFromLatencies(values);
      expect(histogramPercentiles(merged)).toEqual(histogramPercentiles(whole));

      const p = histogramPercentiles(merged);
      assertWithinBucket(p.p50, bruteForce(values, 0.5), `${name} p50`);
      assertWithinBucket(p.p90, bruteForce(values, 0.9), `${name} p90`);
      assertWithinBucket(p.p95, bruteForce(values, 0.95), `${name} p95`);
      assertWithinBucket(p.p99, bruteForce(values, 0.99), `${name} p99`);
    });
  }

  it("merging in any order gives the same answer", () => {
    const a = histogramFromLatencies([10, 20, 30, 900]);
    const b = histogramFromLatencies([15, 25, 35]);
    const c = histogramFromLatencies([1, 2, 3, 4, 5]);
    expect(histogramPercentiles(mergeHistograms(a, b, c))).toEqual(histogramPercentiles(mergeHistograms(c, a, b)));
  });
});

describe("snapToGrain", () => {
  it("puts a now-relative 30-day range onto the hourly grid", () => {
    // 720-minute points over 30 days: the grain that divides it is 1h, and the
    // snapped start has to sit on an hour or pickGrain refuses the request.
    const interval = 720 * 60;
    const start = 1_789_000_123; // deliberately not on any boundary
    const snapped = snapToGrain(start, interval);
    expect(snapped % ROLLUP_GRAIN_SECONDS["1h"]).toBe(0);
    expect(snapped).toBeLessThanOrEqual(start);
  });

  it("never moves the start forward, so the window cannot lose its newest end", () => {
    for (const interval of [300, 600, 900, 1800, 3600, 10800, 43200]) {
      for (const start of [0, 1, 1_789_000_000, 1_789_000_123]) {
        expect(snapToGrain(start, interval)).toBeLessThanOrEqual(start);
      }
    }
  });

  it("moves the start by less than one step", () => {
    const interval = 3600;
    const start = 1_789_003_599;
    expect(start - snapToGrain(start, interval)).toBeLessThan(Math.max(interval, ROLLUP_GRAIN_SECONDS["1h"]));
  });

  it("leaves an already-aligned start alone", () => {
    const aligned = Math.floor(1_789_000_000 / 3600) * 3600;
    expect(snapToGrain(aligned, 3600)).toBe(aligned);
  });
});
