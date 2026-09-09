import { describe, it, expect } from "vitest";
import { derivePageStatus, type LatestStatus } from "./pageStatus.js";
import { CollapseStatusCounts } from "../../clientTools.js";
import { PAGE_STATUS_MESSAGES } from "../../global-constants.js";
import GC from "../../global-constants.js";

// The page status derivation, and in particular the promise made in
// pageStatus.ts: that its private copy of ADR 0007's collapse agrees with
// `clientTools.CollapseStatusCounts`. The copy exists so the scheduler process
// does not have to load a client bundle entry point; this file is what stops the
// two drifting, since nothing else would notice until a page told a customer the
// wrong thing.

/** Builds a page of monitors whose latest samples produce the given counts. */
function pageOf(counts: { up: number; down: number; degraded: number; maintenance: number; silent?: number }) {
  const monitorTags: string[] = [];
  const latest: LatestStatus[] = [];
  const push = (status: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const tag = `${status}-${i}`;
      monitorTags.push(tag);
      latest.push({ monitor_tag: tag, status });
    }
  };
  push(GC.UP, counts.up);
  push(GC.DOWN, counts.down);
  push(GC.DEGRADED, counts.degraded);
  push(GC.MAINTENANCE, counts.maintenance);
  // Monitors that exist but have never reported: present in the tag list, absent
  // from `latest`. These are what make an empty bucket reachable.
  for (let i = 0; i < (counts.silent ?? 0); i++) monitorTags.push(`silent-${i}`);
  return { monitorTags, latest, incidentImpacts: [], maintenanceImpacts: [] };
}

describe("derivePageStatus: ADR 0007 agreement", () => {
  const combinations: Array<{ up: number; down: number; degraded: number; maintenance: number }> = [];
  for (const up of [0, 1, 5]) {
    for (const down of [0, 1, 3]) {
      for (const degraded of [0, 1, 3]) {
        for (const maintenance of [0, 1, 3]) {
          combinations.push({ up, down, degraded, maintenance });
        }
      }
    }
  }

  it("collapses exactly as CollapseStatusCounts does, for every combination", () => {
    for (const counts of combinations) {
      const derived = derivePageStatus(pageOf(counts));
      const canonical = CollapseStatusCounts({
        countOfUp: counts.up,
        countOfDown: counts.down,
        countOfDegraded: counts.degraded,
        countOfMaintenance: counts.maintenance,
      });
      expect(derived.status, JSON.stringify(counts)).toBe(canonical);
    }
  });

  it("returns NO_DATA when nothing has reported, rather than UP", () => {
    const derived = derivePageStatus(pageOf({ up: 0, down: 0, degraded: 0, maintenance: 0, silent: 3 }));
    expect(derived.status).toBe(GC.NO_DATA);
    expect(derived.statusSummary).toBe(PAGE_STATUS_MESSAGES.NO_DATA);
  });

  it("never lets maintenance mask a problem", () => {
    expect(derivePageStatus(pageOf({ up: 0, down: 1, degraded: 0, maintenance: 50 })).status).toBe(GC.DOWN);
    expect(derivePageStatus(pageOf({ up: 0, down: 0, degraded: 1, maintenance: 50 })).status).toBe(GC.DEGRADED);
  });

  it("uses the 75% threshold for wording only", () => {
    // One monitor down out of a hundred is still DOWN, phrased as partial.
    const partial = derivePageStatus(pageOf({ up: 99, down: 1, degraded: 0, maintenance: 0 }));
    expect(partial.status).toBe(GC.DOWN);
    expect(partial.statusSummary).toBe(PAGE_STATUS_MESSAGES.PARTIAL_OUTAGE);

    const major = derivePageStatus(pageOf({ up: 1, down: 9, degraded: 0, maintenance: 0 }));
    expect(major.status).toBe(GC.DOWN);
    expect(major.statusSummary).toBe(PAGE_STATUS_MESSAGES.MAJOR_OUTAGE);
  });
});

describe("derivePageStatus: precedence", () => {
  const base = {
    monitorTags: ["api"],
    latest: [{ monitor_tag: "api", status: GC.UP }],
  };

  it("prefers a declared incident impact over a healthy sample", () => {
    const derived = derivePageStatus({
      ...base,
      incidentImpacts: [
        { monitor_tag: "api", monitor_impact: "DEGRADED", component_impact: "PARTIAL_OUTAGE", impact_override: null },
      ],
      maintenanceImpacts: [],
    });
    expect(derived.components[0].component_impact).toBe("PARTIAL_OUTAGE");
    expect(derived.components[0].source).toBe("incident");
  });

  it("prefers an incident-level override over the incident's own component impact", () => {
    const derived = derivePageStatus({
      ...base,
      incidentImpacts: [
        {
          monitor_tag: "api",
          monitor_impact: "DEGRADED",
          component_impact: "DEGRADED_PERFORMANCE",
          impact_override: "MAJOR_OUTAGE",
        },
      ],
      maintenanceImpacts: [],
    });
    expect(derived.components[0].component_impact).toBe("MAJOR_OUTAGE");
    expect(derived.components[0].source).toBe("override");
  });

  it("prefers an incident over a maintenance on the same component", () => {
    const derived = derivePageStatus({
      ...base,
      incidentImpacts: [
        { monitor_tag: "api", monitor_impact: "DOWN", component_impact: "MAJOR_OUTAGE", impact_override: null },
      ],
      maintenanceImpacts: [
        { monitor_tag: "api", monitor_impact: "MAINTENANCE", component_impact: "UNDER_MAINTENANCE" },
      ],
    });
    expect(derived.components[0].component_impact).toBe("MAJOR_OUTAGE");
    expect(derived.components[0].source).toBe("incident");
  });

  it("takes the worst when one component has several declarations", () => {
    const derived = derivePageStatus({
      ...base,
      incidentImpacts: [
        {
          monitor_tag: "api",
          monitor_impact: "DEGRADED",
          component_impact: "DEGRADED_PERFORMANCE",
          impact_override: null,
        },
        { monitor_tag: "api", monitor_impact: "DOWN", component_impact: "MAJOR_OUTAGE", impact_override: null },
      ],
      maintenanceImpacts: [],
    });
    expect(derived.components[0].component_impact).toBe("MAJOR_OUTAGE");
  });

  it("infers a communication value for a row written before C2", () => {
    const derived = derivePageStatus({
      ...base,
      incidentImpacts: [{ monitor_tag: "api", monitor_impact: "DOWN", component_impact: null, impact_override: null }],
      maintenanceImpacts: [],
    });
    expect(derived.components[0].component_impact).toBe("MAJOR_OUTAGE");
  });

  it("reports the page's worst component impact exactly, while the headline stays proportional", () => {
    const derived = derivePageStatus({
      monitorTags: ["a", "b", "c", "d"],
      latest: [
        { monitor_tag: "a", status: GC.UP },
        { monitor_tag: "b", status: GC.UP },
        { monitor_tag: "c", status: GC.UP },
        { monitor_tag: "d", status: GC.UP },
      ],
      incidentImpacts: [
        { monitor_tag: "a", monitor_impact: "DOWN", component_impact: "MAJOR_OUTAGE", impact_override: null },
      ],
      maintenanceImpacts: [],
    });
    // The component genuinely has a major outage...
    expect(derived.component_impact).toBe("MAJOR_OUTAGE");
    // ...and one component of four does not make the whole page a major outage.
    expect(derived.statusSummary).toBe(PAGE_STATUS_MESSAGES.PARTIAL_OUTAGE);
  });
});
