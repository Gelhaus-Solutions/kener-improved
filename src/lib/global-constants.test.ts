import { describe, expect, it } from "vitest";
import GC, { isMonitoringStatus } from "./global-constants.js";
import { MONITOR_TYPES } from "./types/monitor.js";

describe("isMonitoringStatus", () => {
  it("accepts only statuses supported by the monitoring filter", () => {
    expect(isMonitoringStatus("UP")).toBe(true);
    expect(isMonitoringStatus("DOWN")).toBe(true);
    expect(isMonitoringStatus("DEGRADED")).toBe(true);
    expect(isMonitoringStatus("MAINTENANCE")).toBe(false);
    expect(isMonitoringStatus("")).toBe(false);
    expect(isMonitoringStatus("invalid")).toBe(false);
  });
});

describe("PROBE_ELIGIBLE_TYPES", () => {
  const eligible: readonly string[] = GC.PROBE_ELIGIBLE_TYPES;

  it("names only monitor types that exist", () => {
    // A typo here is a check that can never be assigned to a probe, and nothing
    // would say so: the assignment would simply never match.
    for (const type of eligible) {
      expect(MONITOR_TYPES as readonly string[], `${type} is not a monitor type`).toContain(type);
    }
  });

  it("excludes every type that needs something of Kener's", () => {
    // The rule is whether a check needs anything but the monitor row. GROUP
    // reads Redis for its members, HEARTBEAT reads the database for the last
    // receipt, SQL needs a connection Kener holds, and PROMETHEUS and DOCKER
    // need server-side reachability. Letting any of them onto a probe is not a
    // degraded check, it is a wrong answer reported confidently.
    for (const type of ["GROUP", "HEARTBEAT", "SQL", "PROMETHEUS", "DOCKER", "NONE"]) {
      expect(eligible, `${type} must never be probe-eligible`).not.toContain(type);
    }
  });

  it("is the five stateless types and nothing else", () => {
    // Pinned as a set rather than described, because widening this list is a
    // security decision about what credentials leave the server, and it should
    // take a deliberate edit to a test rather than happening in passing.
    expect([...eligible].sort()).toEqual(["API", "DNS", "PING", "SSL", "TCP"]);
  });
});
