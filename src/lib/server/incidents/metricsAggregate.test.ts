import { describe, it, expect } from "vitest";
import {
  aggregateIncidentMetrics,
  bucketStart,
  mean,
  median,
  nextBucket,
  pickTrendBucket,
  type IncidentForAggregate,
} from "./metricsAggregate.js";
import type { IncidentDurations } from "./metrics.js";

const DAY = 86400;

function durations(overrides: Partial<IncidentDurations> = {}): IncidentDurations {
  return {
    impact_started_at: null,
    mttd: null,
    mtta: null,
    mttr: null,
    time_to_identify: null,
    time_to_mitigate: null,
    basis: "ALERT",
    ...overrides,
  };
}

function incident(id: number, overrides: Partial<IncidentForAggregate> = {}): IncidentForAggregate {
  return {
    id,
    title: `Incident ${id}`,
    severity: "MAJOR",
    startedAt: 0,
    monitorTags: ["api"],
    durations: durations(),
    ...overrides,
  };
}

describe("mean and median", () => {
  it("returns null rather than NaN for an empty set", () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
  });

  it("averages the two middle values on an even count", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it("takes the middle value on an odd count", () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it("shows why both are reported: one long incident moves only the mean", () => {
    // The presentation caveat F3 asks for, as a test. Four quick incidents and
    // one 40-hour one: the mean is over eight hours, the median is 10 minutes.
    const values = [600, 600, 600, 600, 40 * 3600];
    expect(mean(values)).toBeCloseTo(29280, 5);
    expect(median(values)).toBe(600);
  });
});

describe("pickTrendBucket", () => {
  it("uses days for a short range", () => {
    expect(pickTrendBucket(30 * DAY)).toBe("day");
  });
  it("uses weeks for a quarter", () => {
    expect(pickTrendBucket(90 * DAY)).toBe("week");
  });
  it("uses months beyond a year", () => {
    expect(pickTrendBucket(500 * DAY)).toBe("month");
  });
});

describe("bucketStart", () => {
  it("floors to the UTC day", () => {
    // 2026-01-01T13:45:00Z -> 2026-01-01T00:00:00Z
    const ts = Math.floor(Date.parse("2026-01-01T13:45:00Z") / 1000);
    expect(new Date(bucketStart(ts, "day") * 1000).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("starts weeks on Monday, not on the epoch's Thursday", () => {
    // 1970-01-01 was a Thursday, so a naive floor(ts / 604800) yields Thursdays.
    // 2026-01-01 is a Thursday; its week must start Monday 2025-12-29.
    const ts = Math.floor(Date.parse("2026-01-01T12:00:00Z") / 1000);
    const start = new Date(bucketStart(ts, "week") * 1000);
    expect(start.toISOString()).toBe("2025-12-29T00:00:00.000Z");
    expect(start.getUTCDay()).toBe(1);
  });

  it("floors to the first of the UTC month", () => {
    const ts = Math.floor(Date.parse("2026-03-17T09:00:00Z") / 1000);
    expect(new Date(bucketStart(ts, "month") * 1000).toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("nextBucket", () => {
  it("advances a month by a month, not by thirty days", () => {
    // February is the case a fixed 30-day step gets wrong.
    const feb = Math.floor(Date.parse("2026-02-01T00:00:00Z") / 1000);
    expect(new Date(nextBucket(feb, "month") * 1000).toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("crosses a year boundary", () => {
    const dec = Math.floor(Date.parse("2026-12-01T00:00:00Z") / 1000);
    expect(new Date(nextBucket(dec, "month") * 1000).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("aggregateIncidentMetrics", () => {
  it("excludes a null acknowledgement from MTTA rather than counting it as zero", () => {
    // F3's stated acceptance criterion. Two incidents acknowledged in 60s and
    // 120s, one never acknowledged at all. MTTA must be 90, over 2 samples.
    // Counting the null as zero would give 60 over 3 - reporting instant
    // acknowledgement for the incident nobody acknowledged.
    const report = aggregateIncidentMetrics(
      [
        incident(1, { durations: durations({ mtta: 60 }) }),
        incident(2, { durations: durations({ mtta: 120 }) }),
        incident(3, { durations: durations({ mtta: null }) }),
      ],
      0,
      10 * DAY,
    );
    const mtta = report.measures.find((m) => m.key === "mtta")!;
    expect(mtta.mean).toBe(90);
    expect(mtta.median).toBe(90);
    expect(mtta.sampleCount).toBe(2);
    expect(report.incidentCount).toBe(3);
  });

  it("reports null for a measure no incident carried", () => {
    const report = aggregateIncidentMetrics([incident(1)], 0, 10 * DAY);
    const mttr = report.measures.find((m) => m.key === "mttr")!;
    expect(mttr.mean).toBeNull();
    expect(mttr.median).toBeNull();
    expect(mttr.sampleCount).toBe(0);
  });

  it("carries mean, median, max and count together for every measure", () => {
    const report = aggregateIncidentMetrics(
      [
        incident(1, { durations: durations({ mttr: 600 }) }),
        incident(2, { durations: durations({ mttr: 600 }) }),
        incident(3, { durations: durations({ mttr: 40 * 3600 }) }),
      ],
      0,
      10 * DAY,
    );
    const mttr = report.measures.find((m) => m.key === "mttr")!;
    expect(mttr.median).toBe(600);
    expect(mttr.max).toBe(144000);
    expect(mttr.sampleCount).toBe(3);
    expect(mttr.mean).toBeGreaterThan(mttr.median!);
  });

  it("counts an incident once per affected component, and says so by not summing", () => {
    const report = aggregateIncidentMetrics(
      [incident(1, { monitorTags: ["api", "web"] }), incident(2, { monitorTags: ["api"] })],
      0,
      10 * DAY,
    );
    expect(report.byComponent).toEqual([
      { monitorTag: "api", count: 2 },
      { monitorTag: "web", count: 1 },
    ]);
    // Three component-incidents across two incidents: the counts deliberately
    // do not sum to incidentCount.
    expect(report.incidentCount).toBe(2);
  });

  it("does not double-count a component listed twice on one incident", () => {
    const report = aggregateIncidentMetrics([incident(1, { monitorTags: ["api", "api"] })], 0, 10 * DAY);
    expect(report.byComponent).toEqual([{ monitorTag: "api", count: 1 }]);
  });

  it("separates detected incidents from operator-declared ones", () => {
    const report = aggregateIncidentMetrics(
      [
        incident(1, { durations: durations({ basis: "ALERT" }) }),
        incident(2, { durations: durations({ basis: "REPORTED" }) }),
        incident(3, { durations: durations({ basis: "REPORTED" }) }),
      ],
      0,
      10 * DAY,
    );
    expect(report.basis).toEqual({ alert: 1, reported: 2 });
  });

  it("emits an empty bucket for a quiet period rather than omitting it", () => {
    // An absent bucket and a bucket with no incidents plot identically, and only
    // one of them is good news.
    const report = aggregateIncidentMetrics([incident(1, { startedAt: 0 })], 0, 3 * DAY, "day");
    expect(report.trend).toHaveLength(3);
    expect(report.trend[0].incidentCount).toBe(1);
    expect(report.trend[1].incidentCount).toBe(0);
    expect(report.trend[2].incidentCount).toBe(0);
    expect(report.trend[1].mttrMedian).toBeNull();
  });

  it("places each incident in the bucket its start falls in", () => {
    const report = aggregateIncidentMetrics(
      [incident(1, { startedAt: 10 }), incident(2, { startedAt: DAY + 10 }), incident(3, { startedAt: DAY + 20 })],
      0,
      3 * DAY,
      "day",
    );
    expect(report.trend.map((p) => p.incidentCount)).toEqual([1, 2, 0]);
  });

  it("groups severities and orders them by frequency", () => {
    const report = aggregateIncidentMetrics(
      [incident(1, { severity: "MINOR" }), incident(2, { severity: "CRITICAL" }), incident(3, { severity: "MINOR" })],
      0,
      10 * DAY,
    );
    expect(report.bySeverity).toEqual([
      { severity: "MINOR", count: 2 },
      { severity: "CRITICAL", count: 1 },
    ]);
  });

  it("handles an empty window without inventing numbers", () => {
    const report = aggregateIncidentMetrics([], 0, 2 * DAY, "day");
    expect(report.incidentCount).toBe(0);
    expect(report.measures.every((m) => m.mean === null && m.sampleCount === 0)).toBe(true);
    expect(report.trend).toHaveLength(2);
    expect(report.bySeverity).toEqual([]);
  });
});
