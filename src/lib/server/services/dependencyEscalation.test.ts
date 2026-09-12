import { describe, it, expect } from "vitest";
import { DEFAULT_RECORDING, evaluateDependencyEscalation, parseRecording } from "./dependencyEscalation.js";
import type { ComponentImpact } from "../incidents/impact.js";
import GC from "../../global-constants.js";

/**
 * C3c's decision, in isolation from the graph that feeds it.
 *
 * The interesting cases are all about what must NOT happen: a monitor with its
 * own problem must not have it relabelled as a dependency's, and a status this
 * function published must never be able to justify itself on the next check.
 */
describe("evaluateDependencyEscalation", () => {
  it("publishes a down dependency as the parent's status", () => {
    const verdict = evaluateDependencyEscalation(GC.UP, "MAJOR_OUTAGE", ["Postgres"]);
    expect(verdict).toEqual({ status: GC.DOWN, reason: "inherited from Postgres" });
  });

  it("publishes a degraded dependency as degraded, not as an outage", () => {
    expect(evaluateDependencyEscalation(GC.UP, "DEGRADED_PERFORMANCE", ["Cache"])?.status).toBe(GC.DEGRADED);
  });

  it("names every dependency that is equally to blame", () => {
    expect(evaluateDependencyEscalation(GC.UP, "MAJOR_OUTAGE", ["Postgres", "Redis"])?.reason).toBe(
      "inherited from Postgres, Redis",
    );
  });

  /**
   * C3b's rule: a hidden or inactive dependency moves the status it always
   * moved and is still not named. The escalation must still happen, so the
   * reason has to stand on its own without a name in it.
   */
  it("still escalates when the dependency is one the page may not name", () => {
    expect(evaluateDependencyEscalation(GC.UP, "MAJOR_OUTAGE", [])).toEqual({
      status: GC.DOWN,
      reason: "inherited from a dependency",
    });
  });

  it("leaves a healthy monitor alone when its dependencies are healthy", () => {
    expect(evaluateDependencyEscalation(GC.UP, "OPERATIONAL", [])).toBeNull();
  });

  /**
   * The latching case, and the reason `childrenImpact` leaves the monitor's own
   * state out. If this function were given the previous verdict instead of the
   * current observation, a parent that once inherited DOWN would keep finding
   * itself DOWN and never recover.
   */
  it("does not re-escalate a monitor whose dependencies have recovered", () => {
    expect(evaluateDependencyEscalation(GC.DOWN, "OPERATIONAL", [])).toBeNull();
  });

  it("never softens a monitor that is worse than its dependencies", () => {
    expect(evaluateDependencyEscalation(GC.DOWN, "DEGRADED_PERFORMANCE", ["Cache"])).toBeNull();
  });

  it("adds nothing when the monitor is already exactly as bad", () => {
    expect(evaluateDependencyEscalation(GC.DOWN, "MAJOR_OUTAGE", ["Postgres"])).toBeNull();
    expect(evaluateDependencyEscalation(GC.DEGRADED, "DEGRADED_PERFORMANCE", ["Cache"])).toBeNull();
  });

  /**
   * Escalates a degraded monitor to down, because a dependency being gone is
   * worse than this monitor being slow, and never the other way round.
   */
  it("escalates from degraded to down, but not from down to degraded", () => {
    expect(evaluateDependencyEscalation(GC.DEGRADED, "MAJOR_OUTAGE", ["Postgres"])?.status).toBe(GC.DOWN);
    expect(evaluateDependencyEscalation(GC.DOWN, "PARTIAL_OUTAGE", ["Postgres"])).toBeNull();
  });

  it("has an answer for every impact the graph can produce", () => {
    const impacts: ComponentImpact[] = [
      "OPERATIONAL",
      "UNDER_MAINTENANCE",
      "DEGRADED_PERFORMANCE",
      "PARTIAL_OUTAGE",
      "MAJOR_OUTAGE",
    ];
    for (const impact of impacts) {
      const verdict = evaluateDependencyEscalation(GC.UP, impact, ["X"]);
      // OPERATIONAL is the only one that is not worse than UP.
      if (impact === "OPERATIONAL") expect(verdict).toBeNull();
      else expect(verdict?.status, impact).toBeTruthy();
    }
  });
});

describe("parseRecording", () => {
  it("is off for anything that is not an explicit true", () => {
    for (const raw of [null, undefined, "", 0, [], {}, { enabled: "yes" }, { enabled: 1 }]) {
      expect(parseRecording(raw).enabled, JSON.stringify(raw) ?? "undefined").toBe(false);
    }
  });

  it("is on only for a real boolean true", () => {
    expect(parseRecording({ enabled: true }).enabled).toBe(true);
  });

  it("ships off", () => {
    expect(DEFAULT_RECORDING.enabled).toBe(false);
  });
});
