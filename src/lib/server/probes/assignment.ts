/**
 * B1e. Which monitors a region checks, resolved from a rule and its exceptions.
 *
 * **This file is pure.** No database, no clock, no registry. It is the piece
 * that decides where every check runs, and a wrong answer here is a monitor
 * that is silently not being checked from where somebody said it should be -
 * which no other layer would report. Pure means it can be exhausted by unit
 * tests rather than inferred from a live fleet.
 *
 * ## Why a rule at all
 *
 * Before this, an assignment was one row naming one monitor and one agent, and
 * "check everything from Frankfurt" meant clicking once per monitor and
 * remembering to click again for every monitor added afterwards. The rule says
 * it once. The exceptions say the rest, in both directions: `EXCLUDE` so a
 * region set to `ALL` can spare one monitor, `INCLUDE` so a region set to `NONE`
 * can still name one.
 *
 * ## Why the answer is then written down
 *
 * A rule and a list of exceptions can answer "is this monitor checked from
 * Frankfurt" without storing anything. They cannot be inspected, diffed, or
 * found in an audit log, and "which monitors is Frankfurt checking" is the
 * question an operator actually asks. So the resolved rows are stored, each
 * carrying which of the two put it there, and this module is what keeps them
 * equal to what the rule and the exceptions mean.
 */

export const REGION_RULES = ["NONE", "ALL"] as const;
export type RegionRule = (typeof REGION_RULES)[number];

export const OVERRIDE_DECISIONS = ["INCLUDE", "EXCLUDE"] as const;
export type OverrideDecision = (typeof OVERRIDE_DECISIONS)[number];

/** Where a resolved row came from. */
export type AssignmentSource = "RULE" | "OVERRIDE";

export const DEFAULT_MODE = "REMOTE_PREFERRED";

export interface RegionRuleRow {
  region_id: number;
  rule: string;
  mode: string;
}

export interface OverrideRow {
  monitor_tag: string;
  region_id: number;
  decision: string;
}

export interface ResolvedAssignment {
  monitor_tag: string;
  region_id: number;
  mode: string;
  source: AssignmentSource;
}

/**
 * The key a monitor and a region make together.
 *
 * Region first, and it is not cosmetic: the region is always digits, so the
 * first colon is unambiguously the separator however odd the tag is. Tag first
 * would let a tag containing a colon collide with another pair.
 */
const pairKey = (tag: string, regionId: number) => `${regionId}:${tag}`;

function ruleOf(raw: string | undefined): RegionRule {
  return raw === "ALL" ? "ALL" : "NONE";
}

/**
 * The concrete `(monitor, region)` rows the rules and exceptions currently mean.
 *
 * Driven by `monitorTags`, never by the exceptions, and that is the load-bearing
 * choice: an `INCLUDE` left behind for a monitor somebody deleted, or for one
 * that is not eligible to run on a probe, would otherwise resolve into an
 * assignment for a monitor that cannot be checked. Iterating the monitors that
 * actually exist makes a stale exception inert rather than harmful.
 *
 * Regions are the union of those carrying a rule and those named by an
 * exception, because a region nobody has given a rule can still have one monitor
 * named on it, and `NONE` is what the absence of a rule means.
 */
export function resolveAssignments(args: {
  rules: readonly RegionRuleRow[];
  monitorTags: readonly string[];
  overrides: readonly OverrideRow[];
}): ResolvedAssignment[] {
  const ruleByRegion = new Map(args.rules.map((r) => [r.region_id, r]));
  const decisionByPair = new Map(args.overrides.map((o) => [pairKey(o.monitor_tag, o.region_id), o.decision]));

  const regionIds = new Set<number>();
  for (const rule of args.rules) regionIds.add(rule.region_id);
  for (const override of args.overrides) regionIds.add(override.region_id);

  const tags = [...args.monitorTags].sort();
  const resolved: ResolvedAssignment[] = [];

  for (const regionId of [...regionIds].sort((a, b) => a - b)) {
    const row = ruleByRegion.get(regionId);
    const rule = ruleOf(row?.rule);
    const mode = row?.mode || DEFAULT_MODE;

    for (const tag of tags) {
      const decision = decisionByPair.get(pairKey(tag, regionId));
      if (decision === "EXCLUDE") continue;
      if (decision === "INCLUDE") {
        resolved.push({ monitor_tag: tag, region_id: regionId, mode, source: "OVERRIDE" });
        continue;
      }
      if (rule === "ALL") {
        resolved.push({ monitor_tag: tag, region_id: regionId, mode, source: "RULE" });
      }
    }
  }
  return resolved;
}

export interface AssignmentDiff {
  create: ResolvedAssignment[];
  update: ResolvedAssignment[];
  remove: Array<{ monitor_tag: string; region_id: number }>;
}

/**
 * What has to change for the stored rows to equal the resolved ones.
 *
 * A diff rather than "delete every row and reinsert", because the stored rows
 * carry an id the audit log and the screen refer to, and because rewriting all
 * of them whenever a monitor is created would make an unremarkable edit look
 * like the whole fleet being reassigned.
 */
export function assignmentDiff(
  current: readonly ResolvedAssignment[],
  desired: readonly ResolvedAssignment[],
): AssignmentDiff {
  const keyOf = (a: { monitor_tag: string; region_id: number }) => pairKey(a.monitor_tag, a.region_id);
  const currentByKey = new Map(current.map((a) => [keyOf(a), a]));
  const desiredByKey = new Map(desired.map((a) => [keyOf(a), a]));

  const create: ResolvedAssignment[] = [];
  const update: ResolvedAssignment[] = [];
  for (const [key, want] of desiredByKey) {
    const have = currentByKey.get(key);
    if (!have) create.push(want);
    else if (have.mode !== want.mode || have.source !== want.source) update.push(want);
  }

  const remove = current
    .filter((a) => !desiredByKey.has(keyOf(a)))
    .map((a) => ({ monitor_tag: a.monitor_tag, region_id: a.region_id }));

  return { create, update, remove };
}
