import { describe, it, expect } from "vitest";
import { descendants, inheritedFrom } from "./dependencyView.js";
import { componentImpactSummary, componentImpactTextClass, derivePageStatus } from "./pageStatus.js";
import { GetStatusColor, GetStatusSummary } from "../../clientTools.js";
import type { DependencyEdge } from "./rollup.js";
import type { ComponentImpact } from "./impact.js";
import GC from "../../global-constants.js";

// The two claims this file exists to hold down:
//
//   1. A monitor's own page and the status page say the same words about the
//      same component. `componentImpactSummary` is a second mapping into the
//      same vocabulary `clientTools` already produces, and nothing but a test
//      would notice the day they disagree.
//   2. The graph walk that feeds the public page is bounded and does not name a
//      child that is not actually the reason for the status shown.

function edge(parent: string, child: string, propagation = "WORST"): DependencyEdge {
  return { parent_monitor_tag: parent, child_monitor_tag: child, relation: "CONTAINS", propagation, weight: 1 };
}

function indexOf(edges: DependencyEdge[]): Map<string, DependencyEdge[]> {
  const map = new Map<string, DependencyEdge[]>();
  for (const e of edges) {
    const list = map.get(e.parent_monitor_tag) ?? [];
    list.push(e);
    map.set(e.parent_monitor_tag, list);
  }
  return map;
}

describe("componentImpactSummary: agreement with clientTools", () => {
  // A page of exactly one monitor is what a monitor's own page is, so the two
  // functions are being asked the identical question here.
  const cases: Array<{ status: string; impact: ComponentImpact }> = [
    { status: GC.UP, impact: "OPERATIONAL" },
    { status: GC.DOWN, impact: "MAJOR_OUTAGE" },
    { status: GC.MAINTENANCE, impact: "UNDER_MAINTENANCE" },
  ];

  for (const { status, impact } of cases) {
    it(`says the same thing as GetStatusSummary for ${status}`, () => {
      const item = {
        ts: 0,
        countOfUp: status === GC.UP ? 1 : 0,
        countOfDown: status === GC.DOWN ? 1 : 0,
        countOfDegraded: status === GC.DEGRADED ? 1 : 0,
        countOfMaintenance: status === GC.MAINTENANCE ? 1 : 0,
        avgLatency: 0,
        maxLatency: 0,
        minLatency: 0,
      };
      expect(componentImpactSummary(impact, false)).toBe(GetStatusSummary(item));
      expect(componentImpactTextClass(impact, false)).toBe(GetStatusColor(item));
    });
  }

  it("reports a monitor that has never reported as having no status, not as healthy", () => {
    const nothing = {
      ts: 0,
      countOfUp: 0,
      countOfDown: 0,
      countOfDegraded: 0,
      countOfMaintenance: 0,
      avgLatency: 0,
      maxLatency: 0,
      minLatency: 0,
    };
    // OPERATIONAL is what derivePageStatus stores for a silent component so the
    // rollup can still move it. Rendering that as healthy is the failure.
    expect(componentImpactSummary("OPERATIONAL", true)).toBe(GetStatusSummary(nothing));
    expect(componentImpactTextClass("OPERATIONAL", true)).toBe(GetStatusColor(nothing));
    expect(componentImpactSummary("OPERATIONAL", true)).not.toBe(componentImpactSummary("OPERATIONAL", false));
  });

  it("keeps DEGRADED and PARTIAL_OUTAGE in the same colour but not the same words", () => {
    expect(componentImpactTextClass("DEGRADED_PERFORMANCE", false)).toBe(
      componentImpactTextClass("PARTIAL_OUTAGE", false),
    );
    expect(componentImpactSummary("DEGRADED_PERFORMANCE", false)).not.toBe(
      componentImpactSummary("PARTIAL_OUTAGE", false),
    );
  });
});

describe("descendants", () => {
  it("walks the whole subtree and resolves a diamond once", () => {
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")];
    expect([...descendants(indexOf(edges), ["a"])].sort()).toEqual(["b", "c", "d"]);
  });

  it("terminates on a cycle", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a")];
    expect([...descendants(indexOf(edges), ["a"])].sort()).toEqual(["a", "b", "c"]);
  });

  it("stops at the same depth the rollup stops at", () => {
    // A chain of twenty. MAX_DEPTH is ten, so the eleventh link and beyond are
    // not in the closure - and must not be, or the page would fetch and render a
    // component whose status the rollup never actually consulted.
    const edges = Array.from({ length: 20 }, (_, i) => edge(`n${i}`, `n${i + 1}`));
    const found = descendants(indexOf(edges), ["n0"]);
    expect(found.has("n10")).toBe(true);
    expect(found.has("n11")).toBe(false);
  });

  it("is empty for a monitor with no children", () => {
    expect(descendants(indexOf([edge("a", "b")]), ["b"]).size).toBe(0);
  });
});

describe("inheritedFrom", () => {
  const resolved = new Map<string, ComponentImpact>([
    ["db", "MAJOR_OUTAGE"],
    ["cache", "DEGRADED_PERFORMANCE"],
    ["cdn", "OPERATIONAL"],
  ]);
  const displayable = new Set(["db", "cache", "cdn"]);

  it("names only the worst child", () => {
    const edges = [edge("api", "db"), edge("api", "cache"), edge("api", "cdn")];
    expect(inheritedFrom({ edges, resolved, displayable, ownImpact: "OPERATIONAL" })).toEqual(["db"]);
  });

  it("names every child tied for worst", () => {
    const tied = new Map<string, ComponentImpact>([
      ["db", "MAJOR_OUTAGE"],
      ["cache", "MAJOR_OUTAGE"],
    ]);
    const edges = [edge("api", "db"), edge("api", "cache")];
    expect(inheritedFrom({ edges, resolved: tied, displayable, ownImpact: "OPERATIONAL" })).toEqual(["db", "cache"]);
  });

  it("names nobody when the monitor's own check is already at least as bad", () => {
    // The parent is down on its own account. Blaming a child for that would be a
    // guess presented as an explanation, and it would be the wrong guess.
    const edges = [edge("api", "db")];
    expect(inheritedFrom({ edges, resolved, displayable, ownImpact: "MAJOR_OUTAGE" })).toEqual([]);
  });

  it("ignores an edge that is recorded but does not propagate", () => {
    const edges = [edge("api", "db", "NONE"), edge("api", "cache")];
    expect(inheritedFrom({ edges, resolved, displayable, ownImpact: "OPERATIONAL" })).toEqual(["cache"]);
  });

  it("does not name a child that is hidden, even when it is the cause", () => {
    // The hidden child still set the status - it took part in the rollup - and
    // the page still must not say its name.
    const edges = [edge("api", "db"), edge("api", "cache")];
    expect(inheritedFrom({ edges, resolved, displayable: new Set(["cache"]), ownImpact: "OPERATIONAL" })).toEqual([]);
  });

  it("names nobody when there is nothing to inherit from", () => {
    expect(inheritedFrom({ edges: [], resolved, displayable, ownImpact: "OPERATIONAL" })).toEqual([]);
  });
});

describe("the attribution matches what the rollup actually did", () => {
  it("names the child whose failure moved the parent", () => {
    const edges = [edge("api", "db"), edge("api", "cdn")];
    const derived = derivePageStatus({
      monitorTags: ["api", "db", "cdn"],
      latest: [
        { monitor_tag: "api", status: GC.UP },
        { monitor_tag: "db", status: GC.DOWN },
        { monitor_tag: "cdn", status: GC.UP },
      ],
      incidentImpacts: [],
      maintenanceImpacts: [],
      rollup: {
        edges,
        settings: [
          { monitor_tag: "api", rollup_mode: "WORST", manual_override: null, manual_override_expires_at: null },
        ],
        nowSeconds: 1000,
      },
    });

    const api = derived.components.find((c) => c.monitor_tag === "api")!;
    expect(api.source).toBe("rollup");
    expect(api.component_impact).toBe("MAJOR_OUTAGE");

    const resolved = new Map(derived.components.map((c) => [c.monitor_tag, c.component_impact]));
    expect(inheritedFrom({ edges, resolved, displayable: new Set(["db", "cdn"]), ownImpact: "OPERATIONAL" })).toEqual([
      "db",
    ]);
  });
});
