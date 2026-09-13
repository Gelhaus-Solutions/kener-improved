import { describe, it, expect } from "vitest";
import {
  REGION_FRESHNESS_SECONDS,
  describeEntry,
  sortForTable,
  statusFromSample,
  type RegionMapEntry,
} from "./mapModel.js";

/**
 * B13. What the map is allowed to say.
 *
 * **"Not reporting is not down" is the rule these tests exist for.** It is the
 * single easiest way to make this feature lie: a region whose agents went
 * offline has no samples, and colouring that red announces an outage that is not
 * happening while colouring it green announces health nobody observed.
 */

const NOW = 1768485600;

const entry = (over: Partial<RegionMapEntry> = {}): RegionMapEntry => ({
  id: 1,
  code: "eu-central",
  name: "EU Central",
  latitude: 50.11,
  longitude: 8.68,
  status: "UP",
  observedAt: NOW,
  latencyMs: 42,
  displayOnly: false,
  agentCount: 1,
  ...over,
});

describe("a region's status comes only from a fresh sample", () => {
  it("reads a recent sample straight through", () => {
    for (const status of ["UP", "DEGRADED", "DOWN", "MAINTENANCE"] as const) {
      expect(statusFromSample({ status, timestamp: NOW }, NOW)).toBe(status);
    }
  });

  // THE RULE. No sample is a third state, never an outage.
  it("calls a region with no sample NO_DATA, not DOWN", () => {
    expect(statusFromSample(null, NOW)).toBe("NO_DATA");
    expect(statusFromSample(undefined, NOW)).toBe("NO_DATA");
    expect(statusFromSample({ status: "UP", timestamp: null }, NOW)).toBe("NO_DATA");
  });

  // A stale green is the most dangerous thing a status map can show: it asserts
  // health from a region that stopped answering.
  it("expires a sample that is too old rather than keeping its colour", () => {
    const stale = NOW - REGION_FRESHNESS_SECONDS - 1;
    expect(statusFromSample({ status: "UP", timestamp: stale }, NOW)).toBe("NO_DATA");
    expect(statusFromSample({ status: "DOWN", timestamp: stale }, NOW)).toBe("NO_DATA");
  });

  it("keeps a sample right at the freshness boundary", () => {
    const edge = NOW - REGION_FRESHNESS_SECONDS;
    expect(statusFromSample({ status: "UP", timestamp: edge }, NOW)).toBe("UP");
  });

  // "We do not recognise this" is not "it is broken".
  it("treats an unrecognised status as NO_DATA rather than an outage", () => {
    expect(statusFromSample({ status: "BANANA", timestamp: NOW }, NOW)).toBe("NO_DATA");
    expect(statusFromSample({ status: null, timestamp: NOW }, NOW)).toBe("NO_DATA");
  });
});

/**
 * The table is the accessible equivalent of the picture. A sighted reader's eye
 * goes to the red pin immediately; alphabetical order would make a screen-reader
 * user hunt for the problem everyone else is handed.
 */
describe("the accessible table leads with the worst state", () => {
  it("orders worst first, then by name", () => {
    const order = sortForTable([
      entry({ id: 1, name: "Alpha", status: "UP" }),
      entry({ id: 2, name: "Bravo", status: "NO_DATA" }),
      entry({ id: 3, name: "Charlie", status: "DOWN" }),
      entry({ id: 4, name: "Delta", status: "DEGRADED" }),
      entry({ id: 5, name: "Echo", status: "MAINTENANCE" }),
    ]).map((e) => e.status);

    expect(order).toEqual(["DOWN", "DEGRADED", "MAINTENANCE", "NO_DATA", "UP"]);
  });

  it("breaks ties by name so the order is stable", () => {
    const names = sortForTable([
      entry({ id: 1, name: "Zulu", status: "DOWN" }),
      entry({ id: 2, name: "Alpha", status: "DOWN" }),
    ]).map((e) => e.name);
    expect(names).toEqual(["Alpha", "Zulu"]);
  });

  it("does not mutate its input", () => {
    const input = [entry({ id: 1, name: "B", status: "UP" }), entry({ id: 2, name: "A", status: "DOWN" })];
    const before = input.map((e) => e.name);
    sortForTable(input);
    expect(input.map((e) => e.name)).toEqual(before);
  });
});

/**
 * B1d. A DISPLAY_ONLY region is recorded and never counted, so it must be
 * visibly distinct or the map implies it influenced a verdict it cannot
 * influence. Its red pin beside a green headline is the point of the mode, not
 * a contradiction.
 */
describe("descriptions", () => {
  it("says when a region does not vote", () => {
    expect(describeEntry(entry({ displayOnly: true, status: "DOWN" }))).toContain("does not vote");
  });

  it("says no recent reports rather than a status for NO_DATA", () => {
    const text = describeEntry(entry({ status: "NO_DATA", latencyMs: null, observedAt: null }));
    expect(text).toContain("no recent reports");
    expect(text).not.toContain("down");
  });

  it("includes latency when there is one", () => {
    expect(describeEntry(entry({ status: "UP", latencyMs: 42 }))).toContain("42ms");
    expect(describeEntry(entry({ status: "UP", latencyMs: null }))).not.toContain("ms");
  });
});
