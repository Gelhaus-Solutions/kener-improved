import { describe, it, expect } from "vitest";
import GC from "$lib/global-constants";
import {
  ALL_FILTER,
  UNCATEGORISED_KEY,
  applyStatusFilter,
  countByStatus,
  groupByCategory,
  isStatusFilter,
  summariseStatuses,
} from "./monitorGrouping";
import type { StatusType } from "$lib/types/status";

describe("summariseStatuses", () => {
  it("is UP only when every member is UP", () => {
    expect(summariseStatuses([GC.UP, GC.UP])).toBe(GC.UP);
  });

  it("reports DOWN when any member is DOWN, whatever the majority says", () => {
    // ADR 0007: the worst state wins, proportion never changes the status.
    expect(summariseStatuses([GC.UP, GC.UP, GC.UP, GC.UP, GC.DOWN])).toBe(GC.DOWN);
  });

  it("prefers DOWN over DEGRADED", () => {
    expect(summariseStatuses([GC.DEGRADED, GC.DOWN])).toBe(GC.DOWN);
  });

  it("does not let maintenance mask a real problem", () => {
    // The case the collapse exists for: a group half under maintenance and half
    // broken is broken, not "under maintenance".
    expect(summariseStatuses([GC.MAINTENANCE, GC.DOWN])).toBe(GC.DOWN);
    expect(summariseStatuses([GC.MAINTENANCE, GC.DEGRADED])).toBe(GC.DEGRADED);
  });

  it("reports MAINTENANCE when that is the worst thing happening", () => {
    expect(summariseStatuses([GC.UP, GC.MAINTENANCE])).toBe(GC.MAINTENANCE);
  });

  it("reports NO_DATA rather than UP when nothing has loaded", () => {
    // A group must not claim to be healthy before its members have arrived.
    expect(summariseStatuses([undefined, undefined])).toBe(GC.NO_DATA);
    expect(summariseStatuses([])).toBe(GC.NO_DATA);
  });

  it("ignores members that have not loaded, rather than counting them as UP", () => {
    expect(summariseStatuses([undefined, GC.DOWN])).toBe(GC.DOWN);
    expect(summariseStatuses([undefined, GC.UP])).toBe(GC.UP);
  });
});

describe("groupByCategory", () => {
  const categories = {
    a: "Network",
    b: "Database",
    c: "Network",
    d: null,
    e: "Database",
  };

  it("orders groups by first appearance, not alphabetically", () => {
    // The operator's page ordering put Network first. Alphabetical would put
    // Database first and silently override an arrangement they made by hand.
    const groups = groupByCategory(["a", "b", "c", "d", "e"], categories);
    expect(groups.map((g) => g.label)).toEqual(["Network", "Database", null]);
  });

  it("keeps each group's members in the order they were given", () => {
    const groups = groupByCategory(["c", "a", "b"], categories);
    const network = groups.find((g) => g.label === "Network");
    expect(network?.tags).toEqual(["c", "a"]);
  });

  it("pins the uncategorised section last even when it appears first", () => {
    const groups = groupByCategory(["d", "a", "b"], categories);
    expect(groups.at(-1)?.key).toBe(UNCATEGORISED_KEY);
    expect(groups.at(-1)?.label).toBeNull();
  });

  it("treats null, empty and whitespace categories as one uncategorised section", () => {
    const groups = groupByCategory(["x", "y", "z"], { x: null, y: "", z: "   " });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(UNCATEGORISED_KEY);
    expect(groups[0].tags).toEqual(["x", "y", "z"]);
  });

  it("trims a category rather than treating the padded name as a second group", () => {
    const groups = groupByCategory(["p", "q"], { p: "Network", q: "  Network  " });
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Network");
  });

  it("does not merge a category literally named like the uncategorised key", () => {
    // The sentinel starts with a space and every category is trimmed, so a
    // customer cannot collide with it however they name a category.
    const groups = groupByCategory(["m", "n"], { m: "uncategorised", n: null });
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("uncategorised");
    expect(groups[1].key).toBe(UNCATEGORISED_KEY);
  });

  it("puts a tag with no entry at all into the uncategorised section", () => {
    const groups = groupByCategory(["ghost"], {});
    expect(groups[0].key).toBe(UNCATEGORISED_KEY);
  });

  it("keeps every tag exactly once", () => {
    const tags = ["a", "b", "c", "d", "e"];
    const groups = groupByCategory(tags, categories);
    expect(groups.flatMap((g) => g.tags).sort()).toEqual([...tags].sort());
  });
});

describe("countByStatus", () => {
  const statuses: Record<string, StatusType | undefined> = {
    a: GC.UP,
    b: GC.DOWN,
    c: GC.UP,
    d: undefined,
  };

  it("counts only the statuses that are present", () => {
    expect(countByStatus(["a", "b", "c", "d"], statuses)).toEqual({ UP: 2, DOWN: 1 });
  });

  it("omits absent statuses rather than reporting them as zero", () => {
    // A healthy page renders one chip, not four disabled ones.
    expect(Object.keys(countByStatus(["a", "c"], statuses))).toEqual([GC.UP]);
  });
});

describe("applyStatusFilter", () => {
  const statuses: Record<string, StatusType | undefined> = { a: GC.UP, b: GC.DOWN, c: undefined };

  it("returns everything for the ALL chip", () => {
    expect(applyStatusFilter(["a", "b", "c"], statuses, ALL_FILTER)).toEqual(["a", "b", "c"]);
  });

  it("keeps only the matching status", () => {
    expect(applyStatusFilter(["a", "b"], statuses, GC.DOWN)).toEqual(["b"]);
  });

  it("keeps monitors whose data has not arrived", () => {
    // Filtering must only ever hide what it can positively rule out; a monitor
    // that failed to load is not evidence that it is healthy.
    expect(applyStatusFilter(["a", "b", "c"], statuses, GC.DOWN)).toEqual(["b", "c"]);
  });

  it("preserves the input order", () => {
    expect(applyStatusFilter(["b", "a"], statuses, ALL_FILTER)).toEqual(["b", "a"]);
  });
});

describe("isStatusFilter", () => {
  it("accepts every status the page can render, and ALL", () => {
    for (const value of [ALL_FILTER, GC.UP, GC.DOWN, GC.DEGRADED, GC.MAINTENANCE, GC.NO_DATA]) {
      expect(isStatusFilter(value)).toBe(true);
    }
  });

  it("rejects anything else, so a hand-edited URL cannot filter to nothing", () => {
    expect(isStatusFilter("up")).toBe(false);
    expect(isStatusFilter("BROKEN")).toBe(false);
    expect(isStatusFilter("")).toBe(false);
    expect(isStatusFilter(null)).toBe(false);
    expect(isStatusFilter(undefined)).toBe(false);
  });
});
