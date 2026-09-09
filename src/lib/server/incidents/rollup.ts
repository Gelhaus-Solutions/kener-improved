import { isComponentImpact, worstComponentImpact, type ComponentImpact } from "./impact.js";

// The dependency rollup: what a parent shows given its children.
//
// Computed at read time rather than materialised. With a few hundred monitors
// this is one query and an in-memory walk, and a materialised column would have
// to be invalidated by every status change on every descendant - which is a
// cache invalidation problem in exchange for microseconds.
//
// **The relationship to GROUP monitors, which is the thing to get right.** A
// GROUP monitor already produces its own status from its members, at check time,
// through `services/groupCall.ts` and a weighted score. The migration records
// those memberships as edges so the graph describes the real system, but the
// rollup **skips GROUP monitors entirely**: their own sample already is a
// rollup, and applying a second one would either silently replace GroupCall's
// weighting with a different rule or double-count the same members. "Existing
// GROUP monitors behave identically" is an acceptance criterion, and this is the
// line that keeps it true.

/** One edge, as the graph reader needs it. */
export interface DependencyEdge {
  parent_monitor_tag: string;
  child_monitor_tag: string;
  relation: string;
  propagation: string;
  weight: number;
}

/** One component's rollup configuration. */
export interface RollupSetting {
  monitor_tag: string;
  rollup_mode: string;
  manual_override: string | null;
  manual_override_expires_at: number | null;
}

/**
 * How deep the walk will go.
 *
 * Ten, and the number is a statement of intent rather than a tuning parameter:
 * this is a status page, not a configuration management database. A chain deeper
 * than ten is a modelling mistake, and stopping is a better answer than spending
 * unbounded time on it during a page render.
 */
export const MAX_DEPTH = 10;

/** Impact scores for the weighted mode, matching groupCall's vocabulary. */
const IMPACT_SCORE: Record<ComponentImpact, number> = {
  OPERATIONAL: 1,
  UNDER_MAINTENANCE: 1,
  DEGRADED_PERFORMANCE: 0.5,
  PARTIAL_OUTAGE: 0.5,
  MAJOR_OUTAGE: 0,
};

/** ...and back again, at the thresholds groupCall uses. */
function scoreToImpact(score: number): ComponentImpact {
  if (score >= 0.99) return "OPERATIONAL";
  if (score >= 0.5) return "DEGRADED_PERFORMANCE";
  return "MAJOR_OUTAGE";
}

/**
 * Would adding this edge close a loop?
 *
 * Checked on insert rather than defended against on read. A cycle in the graph
 * makes the rollup non-terminating in principle and merely wrong in practice
 * (the depth limit stops it), and either way the operator who typed it deserves
 * to be told at the moment they typed it rather than to find a component
 * reporting nonsense later.
 */
export function wouldCreateCycle(edges: DependencyEdge[], parent: string, child: string): boolean {
  if (parent === child) return true;
  // Walk down from the prospective child. If the prospective parent is reachable,
  // the new edge closes a loop.
  const childrenOf = new Map<string, string[]>();
  for (const edge of edges) {
    const list = childrenOf.get(edge.parent_monitor_tag) ?? [];
    list.push(edge.child_monitor_tag);
    childrenOf.set(edge.parent_monitor_tag, list);
  }

  const seen = new Set<string>();
  const stack = [child];
  while (stack.length > 0) {
    const tag = stack.pop()!;
    if (tag === parent) return true;
    if (seen.has(tag)) continue;
    seen.add(tag);
    for (const next of childrenOf.get(tag) ?? []) stack.push(next);
  }
  return false;
}

/** True when a pin is set and has not lapsed. */
export function activeOverride(setting: RollupSetting | undefined, nowSeconds: number): ComponentImpact | null {
  if (!setting || !isComponentImpact(setting.manual_override)) return null;
  if (setting.manual_override_expires_at !== null && setting.manual_override_expires_at <= nowSeconds) return null;
  return setting.manual_override;
}

export interface RollupInput {
  edges: DependencyEdge[];
  settings: RollupSetting[];
  /** Each component's status before any rollup is applied. */
  own: Map<string, ComponentImpact>;
  /** Tags whose own status is already a rollup. Skipped. See the header. */
  selfRollingTags?: Set<string>;
  nowSeconds: number;
}

/**
 * Applies the graph to a set of already-derived component statuses.
 *
 * Returns a new map; the input is not modified, so a caller can compare before
 * and after to see what the graph actually changed - which is how the admin
 * screen explains a value.
 *
 * A parent takes the **worst of its own status and what rolls up**, never the
 * rollup alone. A parent whose own check is failing while every child is healthy
 * is still failing, and reporting it as healthy because its children are would be
 * exactly the masking ADR 0007 forbids.
 */
export function applyRollup(input: RollupInput): Map<string, ComponentImpact> {
  const result = new Map(input.own);
  const settingByTag = new Map(input.settings.map((s) => [s.monitor_tag, s]));
  const selfRolling = input.selfRollingTags ?? new Set<string>();

  const childrenOf = new Map<string, DependencyEdge[]>();
  for (const edge of input.edges) {
    if (edge.propagation === "NONE") continue;
    const list = childrenOf.get(edge.parent_monitor_tag) ?? [];
    list.push(edge);
    childrenOf.set(edge.parent_monitor_tag, list);
  }

  // Memoised across the whole walk, so a diamond - two parents sharing a child -
  // resolves that child once rather than once per path.
  const resolved = new Map<string, ComponentImpact>();

  function resolve(tag: string, depth: number, path: Set<string>): ComponentImpact {
    const cached = resolved.get(tag);
    if (cached !== undefined) return cached;

    const ownImpact = result.get(tag) ?? "OPERATIONAL";
    const setting = settingByTag.get(tag);

    // A live pin short-circuits everything below it, which is the point of a pin.
    const pinned = activeOverride(setting, input.nowSeconds);
    if (pinned) {
      resolved.set(tag, pinned);
      return pinned;
    }

    const mode = setting?.rollup_mode ?? "NONE";
    const edges = childrenOf.get(tag) ?? [];

    // A cycle reached through the walk, or a graph deeper than we will follow.
    // Answering with the component's own status is the safe stop: it is a fact
    // about the component rather than a guess about the graph.
    if (mode === "NONE" || edges.length === 0 || selfRolling.has(tag)) {
      resolved.set(tag, ownImpact);
      return ownImpact;
    }

    // Truncated: either the graph is deeper than we follow, or this tag is
    // already on the current path. Answer with the component's own status - a
    // fact about the component rather than a guess about the graph - but do
    // **not** memoise it. The memo is keyed on the tag alone, so caching a
    // truncated answer would hand it to a later, shallower path that could have
    // resolved the subtree properly.
    if (depth >= MAX_DEPTH || path.has(tag)) {
      return ownImpact;
    }

    const nextPath = new Set(path).add(tag);
    const childImpacts = edges.map((edge) => resolve(edge.child_monitor_tag, depth + 1, nextPath));

    let rolled: ComponentImpact;
    if (mode === "WEIGHTED") {
      let weighted = 0;
      let total = 0;
      edges.forEach((edge, i) => {
        weighted += edge.weight * IMPACT_SCORE[childImpacts[i]];
        total += edge.weight;
      });
      rolled = scoreToImpact(total > 0 ? weighted / total : 1);
    } else {
      rolled = worstComponentImpact(childImpacts);
    }

    // Worst of own and rolled up. See the docstring.
    const combined = worstComponentImpact([ownImpact, rolled]);
    resolved.set(tag, combined);
    return combined;
  }

  for (const tag of result.keys()) {
    result.set(tag, resolve(tag, 0, new Set()));
  }
  return result;
}
