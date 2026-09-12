import { describe, it, expect } from "vitest";
import {
  LATENCY_METRICS,
  cronIntervalSeconds,
  latencySampleAdvice,
  quantileFor,
  samplesBeforePercentileIsMax,
  type LatencyMetric,
} from "./latency-metrics.js";
import { percentileOf } from "./server/services/latencyThreshold.js";

describe("samplesBeforePercentileIsMax", () => {
  it("is the count each percentile needs", () => {
    expect(samplesBeforePercentileIsMax("p50")).toBe(2);
    expect(samplesBeforePercentileIsMax("p90")).toBe(10);
    expect(samplesBeforePercentileIsMax("p95")).toBe(20);
    expect(samplesBeforePercentileIsMax("p99")).toBe(100);
  });

  it("asks nothing of avg, which is never the maximum", () => {
    expect(samplesBeforePercentileIsMax("avg")).toBe(1);
  });

  /**
   * The number is only worth printing if it is the real boundary, so assert it
   * against `percentileOf` itself rather than against the formula again. One
   * below the answer, the percentile IS the maximum and a single spike carries
   * the verdict; at the answer, it is not.
   */
  it("is exactly where percentileOf stops returning the maximum", () => {
    for (const metric of LATENCY_METRICS) {
      if (metric === "avg") continue;
      const n = samplesBeforePercentileIsMax(metric);
      const values = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

      expect(percentileOf(values(n - 1), metric), `${metric} at ${n - 1}`).toBe(n - 1);
      expect(percentileOf(values(n), metric), `${metric} at ${n}`).toBeLessThan(n);
    }
  });

  it("does not round a binary-floating-point 10.000000000000002 up to 11", () => {
    // 1/(1-0.9) is not 10 in doubles, which is why the percent form is used.
    expect(samplesBeforePercentileIsMax("p90")).not.toBe(11);
  });
});

describe("quantileFor", () => {
  it("reads the quantile out of the metric name", () => {
    expect(quantileFor("p50")).toBe(0.5);
    expect(quantileFor("p90")).toBe(0.9);
    expect(quantileFor("p95")).toBe(0.95);
    expect(quantileFor("p99")).toBe(0.99);
  });

  it("has none for avg", () => {
    expect(quantileFor("avg")).toBeNull();
  });
});

describe("cronIntervalSeconds", () => {
  it("reads the common patterns", () => {
    expect(cronIntervalSeconds("* * * * *")).toBe(60);
    expect(cronIntervalSeconds("*/5 * * * *")).toBe(300);
    expect(cronIntervalSeconds("0 * * * *")).toBe(3600);
  });

  it("takes the widest gap, not the first", () => {
    // Two runs a minute apart, then nothing for the rest of the hour. The
    // sparse stretch is the one a window has to survive.
    expect(cronIntervalSeconds("0,1 * * * *")).toBe(3540);
  });

  it("says nothing for a pattern it cannot read", () => {
    expect(cronIntervalSeconds("not a cron")).toBeNull();
    expect(cronIntervalSeconds("")).toBeNull();
    expect(cronIntervalSeconds(null)).toBeNull();
    expect(cronIntervalSeconds(undefined)).toBeNull();
  });
});

describe("latencySampleAdvice", () => {
  it("warns about the shipped defaults, which cannot produce a p95", () => {
    // 5 minute window, 1 minute cron: 5 samples where p95 needs 20, so every
    // p95 verdict is really "one check was slow".
    expect(latencySampleAdvice("p95", 5, 60)).toEqual({
      samples: 5,
      required: 20,
      suggestedWindowMinutes: 20,
    });
  });

  it("is quiet once the window is wide enough", () => {
    expect(latencySampleAdvice("p95", 20, 60)).toBeNull();
    expect(latencySampleAdvice("p90", 10, 60)).toBeNull();
    expect(latencySampleAdvice("p50", 2, 60)).toBeNull();
  });

  it("scales the suggestion with the monitor's own cron", () => {
    // A five-minute cron needs a hundred minutes of window for a p95.
    expect(latencySampleAdvice("p95", 30, 300)?.suggestedWindowMinutes).toBe(100);
  });

  it("never warns about avg", () => {
    expect(latencySampleAdvice("avg", 1, 3600)).toBeNull();
  });

  it("says nothing when it cannot tell", () => {
    expect(latencySampleAdvice("p95", 5, null)).toBeNull();
    expect(latencySampleAdvice("p95", 0, 60)).toBeNull();
    expect(latencySampleAdvice("p95", Number.NaN, 60)).toBeNull();
  });

  it("agrees with percentileOf about every metric at the window it suggests", () => {
    for (const metric of LATENCY_METRICS as readonly LatencyMetric[]) {
      const advice = latencySampleAdvice(metric, 1, 60);
      if (!advice) continue;
      const suggested = latencySampleAdvice(metric, advice.suggestedWindowMinutes, 60);
      expect(suggested, `${metric} still warns at its own suggestion`).toBeNull();
    }
  });
});
