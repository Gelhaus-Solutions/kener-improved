import { describe, it, expect } from "vitest";
import { siteDataKeys } from "./siteDataKeys.js";
import { SITE_DATA_KEY, DEFAULT_THRESHOLD, LATENCY_METRICS } from "../services/latencyThreshold.js";
import { SITE_DATA_KEY as DEPENDENCY_RECORDING_KEY, DEFAULT_RECORDING } from "../services/dependencyEscalation.js";

function keyFor(key: string) {
  return siteDataKeys.find((k) => k.key === key);
}

/**
 * Every key any screen writes has to be registered here, or `InsertKeyValue`
 * throws `Invalid key` and the save fails with no clue as to why.
 *
 * B5 shipped the reader, the 10-second cache, the invalidator and the whole
 * Site Configurations form, and never added the one line that lets the value be
 * written. Nothing caught it because no test wrote through the real registry.
 */
describe("latencyThresholdDefault is a writable key", () => {
  it("is registered at all", () => {
    expect(keyFor(SITE_DATA_KEY)).toBeDefined();
  });

  it("stores as an object, so it is JSON.parsed back on read", () => {
    expect(keyFor(SITE_DATA_KEY)?.data_type).toBe("object");
  });

  it("accepts the shipped default", () => {
    expect(keyFor(SITE_DATA_KEY)?.isValid(JSON.stringify(DEFAULT_THRESHOLD))).toBe(true);
  });

  it("accepts every supported metric", () => {
    for (const metric of LATENCY_METRICS) {
      const rule = { ...DEFAULT_THRESHOLD, metric };
      expect(keyFor(SITE_DATA_KEY)?.isValid(JSON.stringify(rule))).toBe(true);
    }
  });

  it("accepts a rule with a down step above the degraded step", () => {
    const rule = { ...DEFAULT_THRESHOLD, degraded_ms: 800, down_ms: 3000 };
    expect(keyFor(SITE_DATA_KEY)?.isValid(JSON.stringify(rule))).toBe(true);
  });

  it("rejects a down step at or below the degraded step", () => {
    // Such a rule can never produce DEGRADED: latency crosses both steps at
    // once and the monitor goes straight to DOWN.
    for (const down_ms of [800, 500]) {
      const rule = { ...DEFAULT_THRESHOLD, degraded_ms: 800, down_ms };
      expect(keyFor(SITE_DATA_KEY)?.isValid(JSON.stringify(rule))).toBe(false);
    }
  });

  it("rejects an unknown metric", () => {
    const rule = { ...DEFAULT_THRESHOLD, metric: "p42" };
    expect(keyFor(SITE_DATA_KEY)?.isValid(JSON.stringify(rule))).toBe(false);
  });

  it("rejects non-positive windows, sample floors and thresholds", () => {
    for (const field of ["window_minutes", "min_samples", "degraded_ms"]) {
      const rule = { ...DEFAULT_THRESHOLD, [field]: 0 };
      expect(keyFor(SITE_DATA_KEY)?.isValid(JSON.stringify(rule))).toBe(false);
    }
  });

  it("rejects a missing enabled flag and anything that is not an object", () => {
    const { enabled: _enabled, ...withoutEnabled } = DEFAULT_THRESHOLD;
    expect(keyFor(SITE_DATA_KEY)?.isValid(JSON.stringify(withoutEnabled))).toBe(false);
    expect(keyFor(SITE_DATA_KEY)?.isValid("[]")).toBe(false);
    expect(keyFor(SITE_DATA_KEY)?.isValid("not json")).toBe(false);
  });

  it("keeps null down_ms meaningful: latency alone never makes it DOWN", () => {
    const rule = { ...DEFAULT_THRESHOLD, down_ms: null };
    expect(keyFor(SITE_DATA_KEY)?.isValid(JSON.stringify(rule))).toBe(true);
  });
});

/**
 * C3c's switch, held to the same standard for the same reason: B5 shipped the
 * reader, the cache, the invalidator and the whole form, and the one line that
 * lets the value be written was missing. Nothing caught it because no test wrote
 * through the real registry.
 */
describe("dependencyRecording is a writable key", () => {
  it("is registered at all", () => {
    expect(keyFor(DEPENDENCY_RECORDING_KEY)).toBeDefined();
  });

  it("stores as an object, so it is JSON.parsed back on read", () => {
    expect(keyFor(DEPENDENCY_RECORDING_KEY)?.data_type).toBe("object");
  });

  it("accepts both positions", () => {
    expect(keyFor(DEPENDENCY_RECORDING_KEY)?.isValid(JSON.stringify(DEFAULT_RECORDING))).toBe(true);
    expect(keyFor(DEPENDENCY_RECORDING_KEY)?.isValid(JSON.stringify({ enabled: true }))).toBe(true);
  });

  /**
   * A payload the reader would take as off has to be refused at the write,
   * or the screen reports "on" while nothing is recording - which is the exact
   * class of failure this whole item exists to remove.
   */
  it("rejects anything the reader would silently read as off", () => {
    for (const payload of ["{}", '{"enabled":"true"}', '{"enabled":1}', "[]", "null", "not json"]) {
      expect(keyFor(DEPENDENCY_RECORDING_KEY)?.isValid(payload), payload).toBe(false);
    }
  });
});

describe("the registry has no duplicate keys", () => {
  it("registers each key exactly once", () => {
    // A duplicate would make `find` return the first entry, so a later, stricter
    // validator would silently never run.
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of siteDataKeys) {
      if (seen.has(entry.key)) duplicates.push(entry.key);
      seen.add(entry.key);
    }
    expect(duplicates).toEqual([]);
  });
});
