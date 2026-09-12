import { describe, it, expect } from "vitest";
import {
  assignmentDiff,
  resolveAssignments,
  type OverrideRow,
  type RegionRuleRow,
  type ResolvedAssignment,
} from "./assignment.js";

const rule = (region_id: number, rule: string, mode = "REMOTE_PREFERRED"): RegionRuleRow => ({
  region_id,
  rule,
  mode,
});
const override = (monitor_tag: string, region_id: number, decision: string): OverrideRow => ({
  monitor_tag,
  region_id,
  decision,
});
const pairs = (rows: ResolvedAssignment[]) => rows.map((r) => `${r.region_id}/${r.monitor_tag}/${r.source}`);

describe("resolveAssignments", () => {
  it("gives a region set to ALL every eligible monitor", () => {
    const resolved = resolveAssignments({
      rules: [rule(5, "ALL")],
      monitorTags: ["api", "web"],
      overrides: [],
    });
    expect(pairs(resolved)).toEqual(["5/api/RULE", "5/web/RULE"]);
  });

  it("gives a region set to NONE nothing at all", () => {
    expect(resolveAssignments({ rules: [rule(5, "NONE")], monitorTags: ["api", "web"], overrides: [] })).toEqual([]);
  });

  it("treats a region with no rule as NONE", () => {
    expect(resolveAssignments({ rules: [], monitorTags: ["api"], overrides: [] })).toEqual([]);
  });

  /**
   * The two directions the exceptions exist for. Without EXCLUDE an ALL region
   * could never spare one monitor, because the next resolve would put it back;
   * without INCLUDE a NONE region could never name one.
   */
  it("spares one monitor from a region that checks everything", () => {
    const resolved = resolveAssignments({
      rules: [rule(5, "ALL")],
      monitorTags: ["api", "web"],
      overrides: [override("web", 5, "EXCLUDE")],
    });
    expect(pairs(resolved)).toEqual(["5/api/RULE"]);
  });

  it("names one monitor on a region that checks nothing", () => {
    const resolved = resolveAssignments({
      rules: [rule(5, "NONE")],
      monitorTags: ["api", "web"],
      overrides: [override("web", 5, "INCLUDE")],
    });
    expect(pairs(resolved)).toEqual(["5/web/OVERRIDE"]);
  });

  it("records an INCLUDE as OVERRIDE even where the rule would have included it anyway", () => {
    // The operator asked for this one by hand, so turning the region back to
    // NONE must leave it in place rather than silently dropping it.
    const resolved = resolveAssignments({
      rules: [rule(5, "ALL")],
      monitorTags: ["api"],
      overrides: [override("api", 5, "INCLUDE")],
    });
    expect(pairs(resolved)).toEqual(["5/api/OVERRIDE"]);
  });

  it("serves a region that has an exception but no rule", () => {
    const resolved = resolveAssignments({
      rules: [],
      monitorTags: ["api"],
      overrides: [override("api", 7, "INCLUDE")],
    });
    expect(pairs(resolved)).toEqual(["7/api/OVERRIDE"]);
  });

  /**
   * The reason the monitor list drives the loop. A left-behind exception must
   * be inert, not an assignment for a monitor that cannot be checked.
   */
  it("ignores an exception for a monitor that no longer exists", () => {
    const resolved = resolveAssignments({
      rules: [rule(5, "NONE")],
      monitorTags: ["api"],
      overrides: [override("deleted", 5, "INCLUDE")],
    });
    expect(resolved).toEqual([]);
  });

  it("ignores an exception for a monitor that is not probe eligible", () => {
    // Callers pass only eligible tags, so ineligibility looks exactly like
    // absence here, and that is the intended behaviour rather than a gap.
    const resolved = resolveAssignments({
      rules: [rule(5, "ALL")],
      monitorTags: ["api"],
      overrides: [override("some-group", 5, "INCLUDE")],
    });
    expect(pairs(resolved)).toEqual(["5/api/RULE"]);
  });

  it("carries the region's mode onto every row it produces", () => {
    const resolved = resolveAssignments({
      rules: [rule(5, "ALL", "REMOTE_ONLY")],
      monitorTags: ["api"],
      overrides: [],
    });
    expect(resolved[0].mode).toBe("REMOTE_ONLY");
  });

  it("resolves every region independently", () => {
    const resolved = resolveAssignments({
      rules: [rule(5, "ALL"), rule(6, "NONE")],
      monitorTags: ["api", "web"],
      overrides: [override("api", 5, "EXCLUDE"), override("api", 6, "INCLUDE")],
    });
    expect(pairs(resolved)).toEqual(["5/web/RULE", "6/api/OVERRIDE"]);
  });

  it("is stable, so a reconcile that changes nothing produces no diff", () => {
    const args = {
      rules: [rule(6, "ALL"), rule(5, "ALL")],
      monitorTags: ["web", "api"],
      overrides: [],
    };
    expect(resolveAssignments(args)).toEqual(resolveAssignments(args));
    expect(pairs(resolveAssignments(args))).toEqual(["5/api/RULE", "5/web/RULE", "6/api/RULE", "6/web/RULE"]);
  });

  it("treats an unrecognised rule as NONE rather than as everything", () => {
    // A value nobody recognises must fail closed: checking every monitor from a
    // region because of a typo is the expensive direction to be wrong in.
    expect(resolveAssignments({ rules: [rule(5, "EVERYTHING")], monitorTags: ["api"], overrides: [] })).toEqual([]);
  });

  it("treats an unrecognised decision as no exception at all", () => {
    const resolved = resolveAssignments({
      rules: [rule(5, "ALL")],
      monitorTags: ["api"],
      overrides: [override("api", 5, "MAYBE")],
    });
    expect(pairs(resolved)).toEqual(["5/api/RULE"]);
  });
});

describe("assignmentDiff", () => {
  const row = (tag: string, region: number, over: Partial<ResolvedAssignment> = {}): ResolvedAssignment => ({
    monitor_tag: tag,
    region_id: region,
    mode: "REMOTE_PREFERRED",
    source: "RULE",
    ...over,
  });

  it("is empty when the stored rows already say the right thing", () => {
    const rows = [row("api", 5), row("web", 5)];
    expect(assignmentDiff(rows, rows)).toEqual({ create: [], update: [], remove: [] });
  });

  it("creates what is missing and removes what is no longer meant", () => {
    const diff = assignmentDiff([row("api", 5), row("gone", 5)], [row("api", 5), row("web", 5)]);
    expect(diff.create).toEqual([row("web", 5)]);
    expect(diff.remove).toEqual([{ monitor_tag: "gone", region_id: 5 }]);
    expect(diff.update).toEqual([]);
  });

  it("updates a row whose source changed without moving it", () => {
    const diff = assignmentDiff([row("api", 5, { source: "RULE" })], [row("api", 5, { source: "OVERRIDE" })]);
    expect(diff).toEqual({ create: [], update: [row("api", 5, { source: "OVERRIDE" })], remove: [] });
  });

  it("updates a row whose mode changed", () => {
    const diff = assignmentDiff([row("api", 5)], [row("api", 5, { mode: "REMOTE_ONLY" })]);
    expect(diff.update).toEqual([row("api", 5, { mode: "REMOTE_ONLY" })]);
  });

  it("keeps the same monitor in two regions apart", () => {
    const diff = assignmentDiff([row("api", 5)], [row("api", 5), row("api", 6)]);
    expect(diff.create).toEqual([row("api", 6)]);
    expect(diff.remove).toEqual([]);
  });
});
