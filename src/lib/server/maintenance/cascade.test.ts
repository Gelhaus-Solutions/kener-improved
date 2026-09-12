import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DependencyEdge } from "../incidents/rollup.js";

/**
 * D4's cascade.
 *
 * **Two things here are worth more than the rest: the direction of the walk, and
 * the opt-out rule.** Walking the graph the wrong way silences the estate that
 * is fine and keeps paging about the one that is deliberately down, which is
 * both wrong and hard to notice. Getting the opt-out backwards means an operator
 * who explicitly asked to be paged through a risky migration is not, which is
 * the failure they will find out about from a customer.
 */

const fake = {
  getAllDependencies: vi.fn<() => Promise<DependencyEdge[]>>(),
  getMaintenancesByMonitorTagsRealtime: vi.fn<(tags: string[]) => Promise<Array<Record<string, unknown>>>>(),
};

vi.mock("../db/db.js", () => ({
  default: {
    getAllDependencies: () => fake.getAllDependencies(),
    getMaintenancesByMonitorTagsRealtime: (tags: string[]) => fake.getMaintenancesByMonitorTagsRealtime(tags),
  },
}));

const { dependencyClosure, windowsAffecting, suppressesAlerts, invalidateDependencyGraph } = await import(
  "./cascade.js"
);

function edge(parent: string, child: string): DependencyEdge {
  return { parent_monitor_tag: parent, child_monitor_tag: child, relation: "DEPENDS_ON", propagation: "WORST", weight: 1 };
}

function window(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    monitor_tag: "db",
    start_date_time: 0,
    end_date_time: 0,
    monitor_impact: "MAINTENANCE",
    suppress_alerts: "YES",
    title: "Database upgrade",
    ...over,
  };
}

let clock = 1_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateDependencyGraph();
  clock += 10_000_000; // Past any cached graph from the previous test.
  fake.getAllDependencies.mockResolvedValue([]);
  fake.getMaintenancesByMonitorTagsRealtime.mockResolvedValue([]);
});

describe("dependencyClosure", () => {
  it("is just the monitor when it depends on nothing", async () => {
    expect(await dependencyClosure("api", clock)).toEqual(["api"]);
  });

  it("walks towards what a monitor depends on, not towards what depends on it", async () => {
    // The direction that matters. In C3's graph a parent inherits its children's
    // worst status, so `api -> db` means the api DEPENDS ON the db. Taking the db
    // down must reach the api; taking the api down must not reach the db.
    fake.getAllDependencies.mockResolvedValue([edge("api", "db")]);

    expect((await dependencyClosure("api", clock)).sort()).toEqual(["api", "db"]);
    expect(await dependencyClosure("db", clock)).toEqual(["db"]);
  });

  it("follows a chain to its end", async () => {
    fake.getAllDependencies.mockResolvedValue([edge("web", "api"), edge("api", "db")]);
    expect((await dependencyClosure("web", clock)).sort()).toEqual(["api", "db", "web"]);
  });

  it("terminates on a cycle rather than hanging the tick", async () => {
    // A graph somebody has managed to make circular must cost a bounded walk.
    fake.getAllDependencies.mockResolvedValue([edge("a", "b"), edge("b", "c"), edge("c", "a")]);
    expect((await dependencyClosure("a", clock)).sort()).toEqual(["a", "b", "c"]);
  });

  it("stops at ten levels, so depth is bounded by design", async () => {
    const edges = Array.from({ length: 30 }, (_, i) => edge(`n${i}`, `n${i + 1}`));
    fake.getAllDependencies.mockResolvedValue(edges);
    const reached = await dependencyClosure("n0", clock);
    expect(reached).toContain("n10");
    expect(reached).not.toContain("n11");
  });

  it("degrades to no cascade when the graph cannot be read", async () => {
    // Never to no suppression: the direct attachment still works, so the
    // behaviour falls back to what it was before the cascade existed.
    fake.getAllDependencies.mockRejectedValue(new Error("database gone"));
    expect(await dependencyClosure("api", clock)).toEqual(["api"]);
  });

  it("reads the graph once for a burst of monitors rather than once each", async () => {
    // The overlay asks this per monitor per tick. A query per monitor per minute
    // for a table nobody edits would be a real cost for no benefit.
    fake.getAllDependencies.mockResolvedValue([edge("api", "db")]);
    await dependencyClosure("api", clock);
    await dependencyClosure("web", clock + 1);
    await dependencyClosure("db", clock + 2);
    expect(fake.getAllDependencies).toHaveBeenCalledTimes(1);
  });

  it("picks up an edited graph on a later tick", async () => {
    fake.getAllDependencies.mockResolvedValue([]);
    await dependencyClosure("api", clock);
    fake.getAllDependencies.mockResolvedValue([edge("api", "db")]);
    // Past the cache's life.
    expect((await dependencyClosure("api", clock + 60_000)).sort()).toEqual(["api", "db"]);
  });
});

describe("windowsAffecting", () => {
  it("asks about the monitor and everything it depends on", async () => {
    fake.getAllDependencies.mockResolvedValue([edge("api", "db")]);
    await windowsAffecting("api", 500, clock);
    const asked = fake.getMaintenancesByMonitorTagsRealtime.mock.calls[0][0];
    expect([...asked].sort()).toEqual(["api", "db"]);
  });

  it("reports which component actually carried the window", async () => {
    // The screen has to be able to say "suppressed because the database is down
    // for work", which needs the tag that matched rather than the one asked about.
    fake.getAllDependencies.mockResolvedValue([edge("api", "db")]);
    fake.getMaintenancesByMonitorTagsRealtime.mockResolvedValue([window({ monitor_tag: "db" })]);
    const [affecting] = await windowsAffecting("api", 500, clock);
    expect(affecting.via_monitor_tag).toBe("db");
    expect(affecting.title).toBe("Database upgrade");
  });

  it("treats a window with no flag as suppressing", async () => {
    // Rows written before D4 have no value, and every one of them suppressed
    // yesterday.
    fake.getMaintenancesByMonitorTagsRealtime.mockResolvedValue([window({ suppress_alerts: undefined })]);
    const [affecting] = await windowsAffecting("db", 500, clock);
    expect(affecting.suppress_alerts).toBe("YES");
  });
});

describe("suppressesAlerts", () => {
  it("is false when no window reaches the monitor", () => {
    expect(suppressesAlerts([])).toBe(false);
  });

  it("is true for an ordinary window", () => {
    expect(suppressesAlerts([{ id: 1, via_monitor_tag: "db", monitor_impact: null, suppress_alerts: "YES", title: "t" }])).toBe(
      true,
    );
  });

  it("lets one opted-out window win over an overlapping ordinary one", () => {
    // The operator who asked to be told is making the more specific request. The
    // cost of honouring it is a page they wanted; the cost of not is an outage
    // nobody heard about.
    const windows = [
      { id: 1, via_monitor_tag: "db", monitor_impact: null, suppress_alerts: "YES", title: "db work" },
      { id: 2, via_monitor_tag: "api", monitor_impact: null, suppress_alerts: "NO", title: "risky migration" },
    ];
    expect(suppressesAlerts(windows)).toBe(false);
  });
});
