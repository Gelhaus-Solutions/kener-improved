import { describe, it, expect } from "vitest";
import { SLO_INCIDENT_COMPONENT_IMPACT } from "./alertingQueue.js";
import { isComponentImpact, monitorImpactFor } from "../incidents/impact.js";

/**
 * What an SLO burn-rate incident is allowed to claim about its monitors.
 *
 * **The bug this pins was self-amplifying, which is why it gets its own file.**
 * `createSloIncident` attached every monitor in the target's scope with
 * `GC.DOWN`, which resolves to MAJOR_OUTAGE. Three things followed:
 *
 *  1. The public page announced a major outage on services that were up. A
 *     burn-rate rule fires on budget consumed over a window, and the service is
 *     very often healthy at the moment it fires.
 *  2. An open incident with a non-null `monitor_impact` makes
 *     `monitorExecuteQueue` write a synthetic sample over the monitor's realtime
 *     data every minute, so the invented outage went into ninety days of bars
 *     and into every uptime percentage.
 *  3. `slaEvaluator` reads that same data, through the hourly rollups and the
 *     raw tail. So the incident manufactured downtime that kept its own burn
 *     rate high, which kept the alert firing.
 *
 * The fix is the projection, not the word: an impact that maps to a null
 * `monitor_impact` writes no overlay row at all, which `impact.ts` is explicit
 * is different from writing an UP row. That is the property asserted here, so a
 * future edit that picks a "more visible" impact fails rather than quietly
 * restarting the loop.
 */
describe("an SLO burn-rate incident does not invent an outage", () => {
  it("declares an impact the incident model actually knows", () => {
    expect(isComponentImpact(SLO_INCIDENT_COMPONENT_IMPACT)).toBe(true);
  });

  // THE LOAD-BEARING ASSERTION. Null means "write no overlay row", so the
  // monitors keep showing what they really reported and the SLO is computed
  // from observation rather than from its own alert.
  it("projects onto no monitor impact, so no synthetic sample is written", () => {
    expect(monitorImpactFor(SLO_INCIDENT_COMPONENT_IMPACT)).toBeNull();
  });

  // Named individually rather than as "not null", so the failure message says
  // which wrong answer was chosen.
  it("is none of the impacts that would feed back into the burn rate", () => {
    expect(SLO_INCIDENT_COMPONENT_IMPACT).not.toBe("MAJOR_OUTAGE");
    expect(SLO_INCIDENT_COMPONENT_IMPACT).not.toBe("PARTIAL_OUTAGE");
    expect(SLO_INCIDENT_COMPONENT_IMPACT).not.toBe("DEGRADED_PERFORMANCE");
  });
});
