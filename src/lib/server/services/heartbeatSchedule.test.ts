import { describe, it, expect } from "vitest";
import { Cron } from "croner";
import { occurrencesAtOrBefore, evaluateSchedule } from "./heartbeatSchedule.js";

const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

describe("occurrencesAtOrBefore", () => {
  it("finds the daily occurrences before now, most recent first", () => {
    const cron = new Cron("0 2 * * *", { timezone: "UTC" });
    const now = new Date("2026-09-12T10:00:00Z").getTime();

    const got = occurrencesAtOrBefore(cron, now, 3).map((ms) => new Date(ms).toISOString());

    expect(got).toEqual(["2026-09-12T02:00:00.000Z", "2026-09-11T02:00:00.000Z", "2026-09-10T02:00:00.000Z"]);
  });

  it("respects the configured timezone rather than the host's", () => {
    // 02:00 in Berlin is 00:00Z in September (CEST, UTC+2).
    const cron = new Cron("0 2 * * *", { timezone: "Europe/Berlin" });
    const now = new Date("2026-09-12T10:00:00Z").getTime();

    expect(new Date(occurrencesAtOrBefore(cron, now, 1)[0]).toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });

  it("crosses a weekend gap that is wider than the measured period", () => {
    // Weekdays at 09:00. On a Monday the next two runs look one day apart, but
    // the previous occurrence is three days back. This is the case a lookback
    // sized from the period alone gets wrong.
    const cron = new Cron("0 9 * * 1-5", { timezone: "UTC" });
    const now = new Date("2026-09-14T09:30:00Z").getTime(); // Monday

    const got = occurrencesAtOrBefore(cron, now, 2).map((ms) => new Date(ms).toISOString());

    expect(got).toEqual(["2026-09-14T09:00:00.000Z", "2026-09-11T09:00:00.000Z"]); // Mon, then Fri
  });

  it("handles a sparse monthly pattern", () => {
    const cron = new Cron("0 3 1 * *", { timezone: "UTC" });
    const now = new Date("2026-09-12T10:00:00Z").getTime();

    const got = occurrencesAtOrBefore(cron, now, 2).map((ms) => new Date(ms).toISOString());

    expect(got).toEqual(["2026-09-01T03:00:00.000Z", "2026-08-01T03:00:00.000Z"]);
  });

  it("widens the lookback when occurrences are clustered", () => {
    // Noon on the 1st to the 3rd of each month. Just after the last of a
    // cluster the next two runs are one day apart, so the measured period is a
    // day - but twelve occurrences reach back over four months. The first
    // lookback cannot cover that, so this only passes if the window widens.
    const cron = new Cron("0 12 1-3 * *", { timezone: "UTC" });
    const now = new Date("2026-09-03T13:00:00Z").getTime();

    const got = occurrencesAtOrBefore(cron, now, 12);

    expect(got).toHaveLength(12);
    expect(new Date(got[0]).toISOString()).toBe("2026-09-03T12:00:00.000Z");
    expect(new Date(got[11]).toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });

  it("returns an occurrence exactly at now", () => {
    const cron = new Cron("0 2 * * *", { timezone: "UTC" });
    const now = new Date("2026-09-12T02:00:00Z").getTime();

    expect(new Date(occurrencesAtOrBefore(cron, now, 1)[0]).toISOString()).toBe("2026-09-12T02:00:00.000Z");
  });
});

describe("evaluateSchedule", () => {
  const base = { pattern: "0 2 * * *", timezone: "UTC", graceSeconds: 900 };

  it("is ON_TIME when the job ran for the open window", () => {
    const got = evaluateSchedule({
      ...base,
      nowSec: sec("2026-09-12T10:00:00Z"),
      lastSec: sec("2026-09-12T02:01:00Z"),
    });

    expect(got.state).toBe("ON_TIME");
    expect(got.missedWindows).toBe(0);
    expect(got.expectedAt).toBe(sec("2026-09-12T02:00:00Z"));
  });

  it("is IN_GRACE while grace has not run out", () => {
    const got = evaluateSchedule({
      ...base,
      nowSec: sec("2026-09-12T02:10:00Z"),
      lastSec: sec("2026-09-11T02:00:30Z"),
    });

    expect(got.state).toBe("IN_GRACE");
    expect(got.dueAt).toBe(sec("2026-09-12T02:15:00Z"));
  });

  it("is LATE the moment grace runs out on a single window", () => {
    const got = evaluateSchedule({
      ...base,
      nowSec: sec("2026-09-12T02:15:01Z"),
      lastSec: sec("2026-09-11T02:00:30Z"),
    });

    expect(got.state).toBe("LATE");
    expect(got.missedWindows).toBe(1);
  });

  it("is MISSING once a second consecutive window goes unmet", () => {
    const got = evaluateSchedule({
      ...base,
      nowSec: sec("2026-09-12T02:15:01Z"),
      lastSec: sec("2026-09-10T02:00:30Z"),
    });

    expect(got.state).toBe("MISSING");
    expect(got.missedWindows).toBe(2);
  });

  it("distinguishes late from missing at the same wall clock", () => {
    // The whole point of B11: identical `now`, different history, different verdict.
    const now = sec("2026-09-12T02:30:00Z");

    expect(evaluateSchedule({ ...base, nowSec: now, lastSec: sec("2026-09-11T02:00:00Z") }).state).toBe("LATE");
    expect(evaluateSchedule({ ...base, nowSec: now, lastSec: sec("2026-09-09T02:00:00Z") }).state).toBe("MISSING");
  });

  it("alerts promptly rather than waiting a whole extra period", () => {
    // A daily job that did not run is flagged at 02:15, not at 27 hours.
    const got = evaluateSchedule({
      ...base,
      nowSec: sec("2026-09-12T02:16:00Z"),
      lastSec: sec("2026-09-11T02:00:00Z"),
    });

    expect(got.state).toBe("LATE");
  });

  it("counts every unmet window when the job never checked in", () => {
    const got = evaluateSchedule({
      ...base,
      nowSec: sec("2026-09-12T10:00:00Z"),
      lastSec: null,
    });

    expect(got.state).toBe("MISSING");
    expect(got.missedWindows).toBeGreaterThan(1);
  });

  it("is still IN_GRACE at the exact instant grace expires", () => {
    // Grace is inclusive: a job that checks in on the last second of its window
    // is on time, not late.
    const got = evaluateSchedule({
      ...base,
      nowSec: sec("2026-09-12T02:15:00Z"),
      lastSec: sec("2026-09-11T02:00:30Z"),
    });

    expect(got.state).toBe("IN_GRACE");
  });

  it("counts a check-in exactly on the expected second as ON_TIME", () => {
    const got = evaluateSchedule({
      ...base,
      nowSec: sec("2026-09-12T09:00:00Z"),
      lastSec: sec("2026-09-12T02:00:00Z"),
    });

    expect(got.state).toBe("ON_TIME");
  });

  it("rejects a pattern that does not parse", () => {
    const got = evaluateSchedule({
      ...base,
      pattern: "not a cron",
      nowSec: sec("2026-09-12T10:00:00Z"),
      lastSec: null,
    });

    expect(got.state).toBe("INVALID");
    expect(got.reason).toBeTruthy();
  });

  it("rejects an unknown timezone rather than silently using the host's", () => {
    const got = evaluateSchedule({
      ...base,
      timezone: "Mars/Olympus_Mons",
      nowSec: sec("2026-09-12T10:00:00Z"),
      lastSec: null,
    });

    expect(got.state).toBe("INVALID");
  });

  it("judges against the configured timezone, not the host's", () => {
    // 02:00 Berlin is 00:00Z. At 00:30Z the Berlin window is open and in grace;
    // a UTC reading of the same pattern would not expect a run for two hours.
    const got = evaluateSchedule({
      pattern: "0 2 * * *",
      timezone: "Europe/Berlin",
      graceSeconds: 3600,
      nowSec: sec("2026-09-12T00:30:00Z"),
      lastSec: sec("2026-09-11T00:05:00Z"),
    });

    expect(got.state).toBe("IN_GRACE");
    expect(got.expectedAt).toBe(sec("2026-09-12T00:00:00Z"));
  });
});
