import db from "../db/db.js";
import { derivePageStatus, type ComponentStatus, type LatestStatus } from "./pageStatus.js";
import { activeOverride, MAX_DEPTH, type DependencyEdge, type RollupSetting } from "./rollup.js";
import { GetMonitorsParsed } from "../controllers/monitorsController.js";
import {
  componentImpactFromMonitorImpact,
  isWorseImpact,
  worstComponentImpact,
  type ComponentImpact,
} from "./impact.js";

// What one monitor's public page says about its place in the dependency graph.
//
// The graph has been changing a component's public status since C3, through
// `pageStatus.applyRollup`, but nothing on the public side ever *said* so: a
// component could read Degraded because a database it depends on was down, and
// the only place that connection existed was the admin screen. This module is
// the answer to "why does this say that", and it is deliberately the same
// derivation the status page runs rather than a second one that could disagree.
//
// **Two filters, and they are not the same filter.** Every monitor in the
// relevant subgraph takes part in the *computation*, hidden and inactive ones
// included, because leaving one out would give this page a different answer from
// the status page for the same component. Only monitors that are ACTIVE and not
// hidden are *displayed*. A hidden dependency therefore still moves the status it
// always moved, and still is not named.

/** One neighbour in the graph, as the public page shows it. */
export interface DependencyViewNode {
  monitor_tag: string;
  name: string;
  /** CONTAINS: composed of. DEPENDS_ON: needs, but is not made of. */
  relation: string;
  /** WORST | WEIGHTED | NONE. NONE is recorded without propagating. */
  propagation: string;
}

export interface MonitorDependencyView {
  /**
   * False when the operator has turned the graph off for this monitor, and then
   * every list below is empty.
   *
   * The status itself is still rolled up - that is what the status page reports
   * and this page must not contradict it - but nothing names a neighbour.
   */
  visible: boolean;
  /** What this monitor is built from, or needs. */
  dependsOn: DependencyViewNode[];
  /** What is built from this monitor, or needs it. */
  partOf: DependencyViewNode[];
  /** This monitor's status as the status page reports it. */
  impact: ComponentImpact;
  /** Where that came from. "rollup" means the graph moved it. */
  source: ComponentStatus["source"];
  /** True when this monitor has never reported and nothing else supplied a status. */
  silent: boolean;
  /** The monitor's own latest sample, before anything was declared or rolled up. */
  ownStatus: string | null;
  /** Names of the visible direct children the rollup took this status from. */
  inheritedFrom: string[];
}

/** Every tag reachable downwards from `roots`, bounded exactly as the rollup is. */
export function descendants(childrenOf: Map<string, DependencyEdge[]>, roots: string[]): Set<string> {
  const found = new Set<string>();
  // Depth is carried per entry rather than per level so the bound matches
  // `applyRollup`'s: it stops at MAX_DEPTH edges from the node it started at.
  const stack: Array<{ tag: string; depth: number }> = roots.map((tag) => ({ tag, depth: 0 }));
  while (stack.length > 0) {
    const { tag, depth } = stack.pop()!;
    if (depth >= MAX_DEPTH) continue;
    for (const edge of childrenOf.get(tag) ?? []) {
      if (found.has(edge.child_monitor_tag)) continue;
      found.add(edge.child_monitor_tag);
      stack.push({ tag: edge.child_monitor_tag, depth: depth + 1 });
    }
  }
  return found;
}

/**
 * The direct children this monitor's rolled-up status came from.
 *
 * Only edges that propagate, only children that are shown, and only when the
 * children are collectively worse than the monitor's own check - otherwise the
 * status came from somewhere else and naming a child for it would be a guess
 * dressed up as an explanation.
 */
export function inheritedFrom(args: {
  edges: DependencyEdge[];
  resolved: Map<string, ComponentImpact>;
  displayable: Set<string>;
  ownImpact: ComponentImpact;
}): string[] {
  const propagating = args.edges.filter((edge) => edge.propagation !== "NONE");
  if (propagating.length === 0) return [];

  const impacts = propagating
    .map((edge) => args.resolved.get(edge.child_monitor_tag))
    .filter((impact): impact is ComponentImpact => impact !== undefined);
  const worst = worstComponentImpact(impacts);
  if (!isWorseImpact(worst, args.ownImpact)) return [];

  return propagating
    .filter((edge) => args.displayable.has(edge.child_monitor_tag))
    .filter((edge) => args.resolved.get(edge.child_monitor_tag) === worst)
    .map((edge) => edge.child_monitor_tag);
}

/**
 * One monitor's dependency view, fetched and derived.
 *
 * The closure it computes over is the monitor, everything below it, its direct
 * parents, and everything below those. Bounded, and it is what the parents need
 * to report their own rolled-up status correctly rather than a status derived
 * from half their children.
 */
export async function getMonitorDependencyView(tag: string, nowSeconds: number): Promise<MonitorDependencyView> {
  const [edges, settings, groupMonitors, setting] = await Promise.all([
    db.getAllDependencies() as Promise<DependencyEdge[]>,
    db.getAllRollupSettings() as Promise<RollupSetting[]>,
    db.getMonitorsByType("GROUP") as Promise<Array<{ tag: string }>>,
    db.getRollupSetting(tag),
  ]);

  const childrenOf = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    const list = childrenOf.get(edge.parent_monitor_tag) ?? [];
    list.push(edge);
    childrenOf.set(edge.parent_monitor_tag, list);
  }

  const directChildren = childrenOf.get(tag) ?? [];
  const directParents = edges.filter((edge) => edge.child_monitor_tag === tag);

  const closure = new Set<string>([tag]);
  for (const t of descendants(childrenOf, [tag])) closure.add(t);
  for (const edge of directParents) closure.add(edge.parent_monitor_tag);
  for (const t of descendants(
    childrenOf,
    directParents.map((edge) => edge.parent_monitor_tag),
  )) {
    closure.add(t);
  }

  const closureTags = [...closure];
  const [latest, incidentImpacts, maintenanceImpacts] = await Promise.all([
    db.getLatestMonitoringDataAllActive(closureTags) as Promise<LatestStatus[]>,
    db.getDeclaredIncidentImpacts(nowSeconds, closureTags),
    db.getDeclaredMaintenanceImpacts(nowSeconds, closureTags),
  ]);

  const derived = derivePageStatus({
    monitorTags: closureTags,
    latest,
    incidentImpacts,
    maintenanceImpacts,
    rollup: {
      edges,
      settings,
      selfRollingTags: new Set(groupMonitors.map((m) => m.tag)),
      nowSeconds,
    },
  });

  const byTag = new Map(derived.components.map((c) => [c.monitor_tag, c]));
  const self = byTag.get(tag);
  const resolved = new Map(derived.components.map((c) => [c.monitor_tag, c.component_impact]));

  // The neighbours worth showing: ACTIVE, not hidden, and in this org. One query
  // for both directions, because a monitor can be on both lists.
  const neighbourTags = [
    ...new Set([
      ...directChildren.map((edge) => edge.child_monitor_tag),
      ...directParents.map((edge) => edge.parent_monitor_tag),
    ]),
  ];
  const visibleNeighbours =
    neighbourTags.length > 0 ? await GetMonitorsParsed({ tags: neighbourTags, status: "ACTIVE", is_hidden: "NO" }) : [];
  const nameByTag = new Map(visibleNeighbours.map((m) => [m.tag, m.name]));
  const displayable = new Set(nameByTag.keys());

  const show = (setting?.show_dependencies ?? "YES") !== "NO";

  const node = (edgeTag: string, edge: DependencyEdge): DependencyViewNode => ({
    monitor_tag: edgeTag,
    name: nameByTag.get(edgeTag) ?? edgeTag,
    relation: edge.relation,
    propagation: edge.propagation,
  });

  // A live pin is not inheritance. `applyRollup` returns the pinned value and
  // marks the component "rollup" because it moved, but naming a child for a
  // status an operator typed by hand would be a lie about where it came from.
  const pinned = activeOverride(setting, nowSeconds) !== null;

  return {
    visible: show,
    dependsOn: show
      ? directChildren.filter((e) => displayable.has(e.child_monitor_tag)).map((e) => node(e.child_monitor_tag, e))
      : [],
    partOf: show
      ? directParents.filter((e) => displayable.has(e.parent_monitor_tag)).map((e) => node(e.parent_monitor_tag, e))
      : [],
    impact: self?.component_impact ?? "OPERATIONAL",
    source: self?.source ?? "silent",
    silent: self?.source === "silent",
    ownStatus: latest.find((row) => row.monitor_tag === tag)?.status ?? null,
    inheritedFrom:
      show && !pinned && self?.source === "rollup"
        ? inheritedFrom({
            edges: directChildren,
            resolved,
            displayable,
            ownImpact: ownImpactOf(latest, tag),
          }).map((childTag) => nameByTag.get(childTag) ?? childTag)
        : [],
  };
}

/**
 * The monitor's status before the graph touched it.
 *
 * Read back from the raw sample rather than from the derived component, because
 * `derivePageStatus` overwrites `component_impact` in place when the rollup moves
 * a component, so by the time we look the "before" value is gone.
 */
function ownImpactOf(latest: LatestStatus[], tag: string): ComponentImpact {
  const status = latest.find((row) => row.monitor_tag === tag)?.status ?? null;
  return componentImpactFromMonitorImpact(status);
}
