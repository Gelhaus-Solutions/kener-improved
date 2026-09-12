import db from "../db/db.js";
import { currentOrgIdOrDefault } from "../db/orgContext.js";
import type { DependencyEdge } from "../incidents/rollup.js";

/**
 * D4. Which components a maintenance window reaches, and whether it silences
 * alerting for them.
 *
 * **The cascade is the half D4 was actually about.** Suppression already worked
 * for a monitor attached to a window, because the overlay writes a MAINTENANCE
 * sample and alert evaluation cannot see those. What it never covered is the
 * service that fails *because* of the work: take the database down on a Sunday
 * and the API depending on it goes down too, alerts, and announces an outage to
 * the public in the middle of planned maintenance.
 *
 * **Direction, because getting it backwards suppresses the wrong half of the
 * estate.** In C3's graph a parent inherits its children's worst status
 * (`rollup.ts` resolves `edge.child_monitor_tag` when asked about a parent), so
 * a **child is a dependency**. A monitor is therefore affected when it is
 * attached to a window, or when anything it transitively depends on - any
 * descendant through `child_monitor_tag` - is.
 *
 * **One definition, used by both alert paths.** Kener's own checks reach this
 * through the overlay in `monitorExecuteQueue`; inbound webhook alerts reach it
 * directly, because they call `CreateIncident` and never touch the overlay. Two
 * definitions of "in maintenance" would drift, and the one that drifted would be
 * the one nobody was watching.
 */

/** A window that reaches a monitor, and how it got there. */
export interface AffectingWindow {
  id: number;
  /** The monitor actually attached to the window. Equal to the asked-about tag for a direct hit. */
  via_monitor_tag: string;
  monitor_impact: string | null;
  /** YES when this window silences alerting, which is the default. */
  suppress_alerts: string;
  title: string;
}

/**
 * How long the dependency graph is held in memory.
 *
 * The overlay asks this question once per monitor per tick, so re-reading the
 * whole graph each time would be a query per monitor per minute for a table that
 * changes when somebody edits it on a screen. Thirty seconds is under the
 * shortest cron interval, so a change is picked up by the next tick but a single
 * tick never pays for it more than once.
 */
const GRAPH_TTL_MS = 30_000;

interface CachedGraph {
  /** monitor -> the monitors it directly depends on. */
  dependsOn: Map<string, string[]>;
  expiresAt: number;
}

/**
 * Per org, and that is not optional.
 *
 * `getAllDependencies` is an org-scoped read, so a single shared cache would
 * serve one tenant's graph to another and silence alerts for components that
 * have nothing to do with the window.
 */
const cache = new Map<number, CachedGraph>();

/** Drops the cached graph. Called when an edge is added or removed. */
export function invalidateDependencyGraph(orgId?: number): void {
  if (orgId === undefined) cache.clear();
  else cache.delete(orgId);
}

async function graphFor(orgId: number, now: number): Promise<Map<string, string[]>> {
  const cached = cache.get(orgId);
  if (cached && cached.expiresAt > now) return cached.dependsOn;

  let edges: DependencyEdge[] = [];
  try {
    edges = await db.getAllDependencies();
  } catch (error) {
    // A graph that cannot be read means no cascade, never no suppression: the
    // direct attachment below still works, so the behaviour degrades to what it
    // was before this existed rather than to alerting during maintenance.
    console.error("Dependency graph read failed, maintenance will not cascade:", error);
    return new Map();
  }

  const dependsOn = new Map<string, string[]>();
  for (const edge of edges) {
    const list = dependsOn.get(edge.parent_monitor_tag) ?? [];
    list.push(edge.child_monitor_tag);
    dependsOn.set(edge.parent_monitor_tag, list);
  }

  cache.set(orgId, { dependsOn, expiresAt: now + GRAPH_TTL_MS });
  return dependsOn;
}

/**
 * How deep the walk goes.
 *
 * The same ten as C3's rollup, and for the same reason: this is a status page,
 * not a configuration management database. It also makes a cycle harmless, so a
 * graph somebody has managed to make circular costs a bounded walk rather than
 * a hung scheduler tick.
 */
const MAX_DEPTH = 10;

/** Everything `tag` transitively depends on, plus `tag` itself. */
export async function dependencyClosure(tag: string, now: number = Date.now()): Promise<string[]> {
  const dependsOn = await graphFor(currentOrgIdOrDefault(), now);
  const seen = new Set<string>([tag]);
  let frontier = [tag];

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const child of dependsOn.get(current) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }

  return [...seen];
}

/**
 * The maintenance windows affecting one monitor right now, directly or through
 * something it depends on.
 *
 * Returns every match rather than the first, because the caller needs two
 * different things from the set: the worst impact to publish, and whether *any*
 * of them declines to suppress alerting. A window that says "keep paging me"
 * wins over one that does not, since the operator asking to be paged is making
 * the more specific request.
 */
export async function windowsAffecting(
  monitorTag: string,
  timestamp: number,
  now: number = Date.now(),
): Promise<AffectingWindow[]> {
  const tags = await dependencyClosure(monitorTag, now);
  const rows = await db.getMaintenancesByMonitorTagsRealtime(tags, timestamp);
  return rows.map((row) => ({
    id: row.id,
    via_monitor_tag: row.monitor_tag,
    monitor_impact: row.monitor_impact,
    suppress_alerts: row.suppress_alerts ?? "YES",
    title: row.title,
  }));
}

/**
 * Whether alerting should stay quiet for this monitor right now.
 *
 * False when no window reaches it, and false when every window that does has
 * opted out of suppression. The second case is the whole point of the per-window
 * flag: an operator watching a risky migration wants to be told the moment the
 * site goes down, and "it was in a maintenance window" is exactly the excuse
 * they do not want their monitoring to make.
 */
export function suppressesAlerts(windows: AffectingWindow[]): boolean {
  if (windows.length === 0) return false;
  // `every`, not `some`: one window opting out is enough to keep paging. The
  // operator who asked to be told is making the more specific request, and the
  // cost of honouring it is a page they wanted, against an outage they were not
  // told about.
  return windows.every((window) => (window.suppress_alerts ?? "YES") !== "NO");
}
