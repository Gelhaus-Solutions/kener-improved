import { describe, it, expect } from "vitest";
import { firstNonUpMinute, since, type ObservedSample } from "./metrics.js";

/** Newest first, which is the order the query hands back and the walk assumes. */
const series = (tag: string, from: number, statuses: string[]): ObservedSample[] =>
  statuses.map((status, i) => ({ monitor_tag: tag, timestamp: from - i * 60, status }));

describe("firstNonUpMinute", () => {
  it("finds the minute the outage began", () => {
    // now, -1m, -2m down; -3m and older up.
    const samples = series("api", 1000, ["DOWN", "DOWN", "DOWN", "UP", "UP"]);
    expect(firstNonUpMinute(samples)).toBe(1000 - 2 * 60);
  });

  it("counts DEGRADED as non-UP", () => {
    const samples = series("api", 1000, ["DEGRADED", "DEGRADED", "UP"]);
    expect(firstNonUpMinute(samples)).toBe(1000 - 60);
  });

  it("ignores a monitor that was healthy at the anchor", () => {
    // The blip earlier in this monitor's window is not this incident's start:
    // the monitor was fine when the incident was detected, so it is attached for
    // communication rather than because it broke.
    const samples = [...series("api", 1000, ["UP", "DOWN", "DOWN", "UP"])];
    expect(firstNonUpMinute(samples)).toBeNull();
  });

  it("declines to name a start when the walk never finds a healthy minute", () => {
    // Everything in the window is down, so the outage began before the window
    // and the oldest sample is the edge of the lookback rather than the start.
    // Naming it would report a detection gap of exactly the lookback for a
    // monitor that has simply been down for days.
    const samples = series("api", 1000, ["DOWN", "DOWN", "DOWN"]);
    expect(firstNonUpMinute(samples)).toBeNull();
  });

  it("takes the earliest across monitors", () => {
    // An incident spanning two components started when the first of them broke.
    const samples = [...series("api", 1000, ["DOWN", "UP"]), ...series("db", 1000, ["DOWN", "DOWN", "DOWN", "UP"])];
    expect(firstNonUpMinute(samples)).toBe(1000 - 2 * 60);
  });

  it("lets one healthy monitor abstain without silencing the other", () => {
    const samples = [...series("api", 1000, ["UP", "UP"]), ...series("db", 1000, ["DOWN", "DOWN", "UP"])];
    expect(firstNonUpMinute(samples)).toBe(1000 - 60);
  });

  it("returns null with nothing to walk", () => {
    expect(firstNonUpMinute([])).toBeNull();
  });
});

describe("since", () => {
  it("measures a duration", () => {
    expect(since(100, 400)).toBe(300);
  });

  it("is null when either end is missing", () => {
    expect(since(null, 400)).toBeNull();
    expect(since(100, null)).toBeNull();
    expect(since(100, undefined)).toBeNull();
  });

  it("is zero for two timestamps that agree", () => {
    expect(since(100, 100)).toBe(0);
  });

  it("refuses to report a negative duration", () => {
    // An operator moved the start to after the resolution. Reporting -900 puts a
    // nonsense point on every chart that averages it, and clamping to zero
    // invents a plausible one; null says the pair cannot be measured.
    expect(since(1000, 100)).toBeNull();
  });
});
