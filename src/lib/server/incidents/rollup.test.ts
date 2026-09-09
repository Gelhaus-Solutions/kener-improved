import { describe, it, expect } from "vitest";
import { applyRollup, wouldCreateCycle, activeOverride, MAX_DEPTH, type DependencyEdge } from "./rollup.js";
import type { ComponentImpact } from "./impact.js";

const edge = (parent: string, child: string, over: Partial<DependencyEdge> = {}): DependencyEdge => ({
  parent_monitor_tag: parent,
  child_monitor_tag: child,
  relation: "CONTAINS",
  propagation: "WORST",
  weight: 1,
  ...over,
});

const setting = (tag: string, mode: string, override: string | null = null, expires: number | null = null) => ({
  monitor_tag: tag,
  rollup_mode: mode,
  manual_override: override,
  manual_override_expires_at: expires,
});

const own = (entries: Record<string, ComponentImpact>) => new Map(Object.entries(entries));

describe("applyRollup", () => {
  it("gives a parent its worst child", () => {
    const result = applyRollup({
      edges: [edge("api", "db"), edge("api", "cache")],
      settings: [setting("api", "WORST")],
      own: own({ api: "OPERATIONAL", db: "MAJOR_OUTAGE", cache: "OPERATIONAL" }),
      nowSeconds: 1000,
    });
    expect(result.get("api")).toBe("MAJOR_OUTAGE");
    // Children are unchanged; the rollup only ever moves parents.
    expect(result.get("db")).toBe("MAJOR_OUTAGE");
    expect(result.get("cache")).toBe("OPERATIONAL");
  });

  it("never lets healthy children mask the parent's own failure", () => {
    const result = applyRollup({
      edges: [edge("api", "db")],
      settings: [setting("api", "WORST")],
      own: own({ api: "MAJOR_OUTAGE", db: "OPERATIONAL" }),
      nowSeconds: 1000,
    });
    expect(result.get("api")).toBe("MAJOR_OUTAGE");
  });

  it("does nothing when the mode is NONE", () => {
    const result = applyRollup({
      edges: [edge("api", "db")],
      settings: [setting("api", "NONE")],
      own: own({ api: "OPERATIONAL", db: "MAJOR_OUTAGE" }),
      nowSeconds: 1000,
    });
    expect(result.get("api")).toBe("OPERATIONAL");
  });

  it("does nothing when the setting is missing entirely", () => {
    const result = applyRollup({
      edges: [edge("api", "db")],
      settings: [],
      own: own({ api: "OPERATIONAL", db: "MAJOR_OUTAGE" }),
      nowSeconds: 1000,
    });
    expect(result.get("api")).toBe("OPERATIONAL");
  });

  it("respects an edge marked NONE while following its siblings", () => {
    const result = applyRollup({
      edges: [edge("api", "db", { propagation: "NONE" }), edge("api", "cache")],
      settings: [setting("api", "WORST")],
      own: own({ api: "OPERATIONAL", db: "MAJOR_OUTAGE", cache: "DEGRADED_PERFORMANCE" }),
      nowSeconds: 1000,
    });
    expect(result.get("api")).toBe("DEGRADED_PERFORMANCE");
  });

  it("propagates through a chain", () => {
    const result = applyRollup({
      edges: [edge("web", "api"), edge("api", "db")],
      settings: [setting("web", "WORST"), setting("api", "WORST")],
      own: own({ web: "OPERATIONAL", api: "OPERATIONAL", db: "MAJOR_OUTAGE" }),
      nowSeconds: 1000,
    });
    expect(result.get("api")).toBe("MAJOR_OUTAGE");
    expect(result.get("web")).toBe("MAJOR_OUTAGE");
  });

  it("weights, so one small member does not condemn the parent", () => {
    const result = applyRollup({
      edges: [
        edge("api", "primary", { propagation: "WEIGHTED", weight: 9 }),
        edge("api", "spare", { propagation: "WEIGHTED", weight: 1 }),
      ],
      settings: [setting("api", "WEIGHTED")],
      own: own({ api: "OPERATIONAL", primary: "OPERATIONAL", spare: "MAJOR_OUTAGE" }),
      nowSeconds: 1000,
    });
    // 0.9 of the weight is healthy, so the parent is degraded rather than down.
    expect(result.get("api")).toBe("DEGRADED_PERFORMANCE");
  });

  it("skips a component whose own status is already a rollup", () => {
    const result = applyRollup({
      edges: [edge("group", "db")],
      settings: [setting("group", "WEIGHTED")],
      own: own({ group: "OPERATIONAL", db: "MAJOR_OUTAGE" }),
      selfRollingTags: new Set(["group"]),
      nowSeconds: 1000,
    });
    // GroupCall already decided; applying a second rule would double-count.
    expect(result.get("group")).toBe("OPERATIONAL");
  });

  describe("manual override", () => {
    it("pins the component regardless of its children", () => {
      const result = applyRollup({
        edges: [edge("api", "db")],
        settings: [setting("api", "WORST", "UNDER_MAINTENANCE", null)],
        own: own({ api: "OPERATIONAL", db: "MAJOR_OUTAGE" }),
        nowSeconds: 1000,
      });
      expect(result.get("api")).toBe("UNDER_MAINTENANCE");
    });

    it("lapses once it expires, and the graph takes over again", () => {
      const settings = [setting("api", "WORST", "OPERATIONAL", 900)];
      const args = {
        edges: [edge("api", "db")],
        settings,
        own: own({ api: "OPERATIONAL", db: "MAJOR_OUTAGE" }),
      };
      expect(applyRollup({ ...args, nowSeconds: 800 }).get("api")).toBe("OPERATIONAL");
      expect(applyRollup({ ...args, nowSeconds: 1000 }).get("api")).toBe("MAJOR_OUTAGE");
    });

    it("ignores an unrecognised override rather than trusting it", () => {
      expect(activeOverride(setting("api", "WORST", "NONSENSE", null), 1000)).toBeNull();
    });
  });

  it("stops at the depth limit instead of running away", () => {
    const edges: DependencyEdge[] = [];
    const settings = [];
    const statuses: Record<string, ComponentImpact> = {};
    const depth = MAX_DEPTH + 5;
    for (let i = 0; i < depth; i++) {
      statuses[`n${i}`] = i === depth - 1 ? "MAJOR_OUTAGE" : "OPERATIONAL";
      settings.push(setting(`n${i}`, "WORST"));
      if (i > 0) edges.push(edge(`n${i - 1}`, `n${i}`));
    }
    const result = applyRollup({ edges, settings, own: own(statuses), nowSeconds: 1000 });
    // The failure is deeper than the walk goes, so the root does not see it -
    // and, crucially, the call returns at all.
    expect(result.get("n0")).toBe("OPERATIONAL");
    expect(result.get(`n${depth - 2}`)).toBe("MAJOR_OUTAGE");
  });

  it("resolves a diamond once per node, not once per path", () => {
    const result = applyRollup({
      edges: [edge("top", "left"), edge("top", "right"), edge("left", "shared"), edge("right", "shared")],
      settings: ["top", "left", "right"].map((t) => setting(t, "WORST")),
      own: own({ top: "OPERATIONAL", left: "OPERATIONAL", right: "OPERATIONAL", shared: "PARTIAL_OUTAGE" }),
      nowSeconds: 1000,
    });
    expect(result.get("top")).toBe("PARTIAL_OUTAGE");
    expect(result.get("left")).toBe("PARTIAL_OUTAGE");
  });
});

describe("wouldCreateCycle", () => {
  it("rejects a self edge", () => {
    expect(wouldCreateCycle([], "api", "api")).toBe(true);
  });

  it("rejects an edge that closes a loop", () => {
    const edges = [edge("web", "api"), edge("api", "db")];
    expect(wouldCreateCycle(edges, "db", "web")).toBe(true);
  });

  it("allows a diamond, which is not a cycle", () => {
    const edges = [edge("top", "left"), edge("top", "right")];
    expect(wouldCreateCycle(edges, "left", "shared")).toBe(false);
    expect(wouldCreateCycle([...edges, edge("left", "shared")], "right", "shared")).toBe(false);
  });

  it("allows an unrelated edge", () => {
    expect(wouldCreateCycle([edge("web", "api")], "billing", "db")).toBe(false);
  });
});
