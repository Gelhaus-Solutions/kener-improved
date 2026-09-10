import db from "../db/db.js";
import GC from "../../global-constants.js";
import { PAGE_STATUS_MESSAGES } from "../../global-constants.js";
import { applyRollup, type DependencyEdge, type RollupSetting } from "./rollup.js";
import {
  componentImpactFromMonitorImpact,
  isComponentImpact,
  monitorImpactFor,
  worstComponentImpact,
  type ComponentImpact,
} from "./impact.js";

// Page status, derived on the server.
//
// **Read `docs/adr/0007-problem-first-overall-status.md` before changing
// anything here.** That ADR is the specification: collapse by severity and never
// by frequency, `NO_DATA` for an empty bucket before any other test, and the 75%
// threshold as a *wording* rule that can never turn a DOWN bucket into an UP one.
// This module reproduces all three; a change to any of them is a product decision
// that needs a new ADR, not a rewrite here.
//
// There are two layers and the boundary between them is the thing most likely to
// be got wrong:
//
//   Layer 1, untouched. The `monitorExecuteQueue` overlay merge writes
//   `monitoring_data` rows and owns the timeline bars, the uptime percentages
//   and alert evaluation. Nothing in this file writes anything.
//
//   Layer 2, here. Per component: the incident-level `impact_override`, else the
//   worst `component_impact` across open incidents, else across ongoing
//   maintenances, else - C3's child rollup, when it exists - else the collapse of
//   that monitor's latest observed status. The page is the worst component.
//
// **Why the page headline still counts components rather than taking the worst.**
// A declared MAJOR_OUTAGE on one component of twenty is exactly true about that
// component and would be a lie as a page headline. So the per-component value is
// exact and the page headline goes back through ADR 0007's collapse over the
// components' mechanical projections, which is what preserves today's wording:
// one component down out of twenty is still "Partial System Outage". The
// declarative layer improves what each component reports; it does not change what
// a page-wide claim means.

/** What a single component's status is, and which layer decided it. */
export interface ComponentStatus {
  monitor_tag: string;
  component_impact: ComponentImpact;
  /** Which rule won. Present so the admin and the API can explain a value. */
  source: "override" | "incident" | "maintenance" | "rollup" | "monitoring" | "silent";
  /** The mechanical projection, or null when the component is operational. */
  monitor_impact: string | null;
}

/** The Tailwind background class for a collapsed status, matching clientTools. */
export function statusBgClass(status: string): string {
  switch (status) {
    case GC.DOWN:
      return "bg-down";
    case GC.DEGRADED:
      return "bg-degraded";
    case GC.MAINTENANCE:
      return "bg-maintenance";
    case GC.UP:
      return "bg-up";
    default:
      return "bg-muted-foreground";
  }
}

/**
 * One component's status in the page's own wording, and its text colour.
 *
 * A *single* component, not a page, which is why these are separate from
 * `summarise` above: that function reads proportions across several components
 * to choose between "Major" and "Partial", and a proportion over one component
 * is always 100%. The strings are the same ones the page header already uses, so
 * a monitor's own page and the status page say the same words about it.
 *
 * `silent` is carried separately because a component that has never reported has
 * no impact to map: `derivePageStatus` gives it OPERATIONAL so the rollup can
 * still move it, and reporting that as healthy is exactly what ADR 0007 forbids.
 */
export function componentImpactSummary(impact: ComponentImpact, silent: boolean): string {
  if (silent) return PAGE_STATUS_MESSAGES.NO_DATA;
  switch (impact) {
    case "MAJOR_OUTAGE":
      return PAGE_STATUS_MESSAGES.MAJOR_OUTAGE;
    case "PARTIAL_OUTAGE":
      return PAGE_STATUS_MESSAGES.PARTIAL_OUTAGE;
    case "DEGRADED_PERFORMANCE":
      return PAGE_STATUS_MESSAGES.DEGRADED_PERFORMANCE;
    case "UNDER_MAINTENANCE":
      return PAGE_STATUS_MESSAGES.UNDER_MAINTENANCE;
    default:
      return PAGE_STATUS_MESSAGES.ALL_OPERATIONAL;
  }
}

/** The Tailwind text class for one component, matching `clientTools.GetStatusColor`. */
export function componentImpactTextClass(impact: ComponentImpact, silent: boolean): string {
  if (silent) return "text-muted-foreground";
  switch (impact) {
    case "MAJOR_OUTAGE":
      return "text-down";
    case "PARTIAL_OUTAGE":
    case "DEGRADED_PERFORMANCE":
      return "text-degraded";
    case "UNDER_MAINTENANCE":
      return "text-maintenance";
    default:
      return "text-up";
  }
}

export interface PageStatus {
  /** The worst component impact on the page. Exact, for the API and webhooks. */
  component_impact: ComponentImpact;
  /** ADR 0007's collapse over the components. Can be NO_DATA; drives the wording. */
  status: string;
  /** The headline, from PAGE_STATUS_MESSAGES. */
  statusSummary: string;
  /** The background class the existing header renders with. */
  statusClass: string;
  components: ComponentStatus[];
}

/** One monitor's latest observed status, as the derivation's floor. */
export interface LatestStatus {
  monitor_tag: string;
  status?: string | null;
}

/**
 * ADR 0007's collapse, over counts.
 *
 * Duplicated from `clientTools.CollapseStatusCounts` rather than imported, and
 * that is a deliberate exception to "one definition". `clientTools` is a client
 * bundle entry point; importing it into a module the relay and the dispatch
 * worker load would drag `$lib` client code into the scheduler process. The two
 * are kept in step by `pageStatus.test.ts`, which asserts they agree, rather than
 * by hoping.
 */
function collapse(counts: { up: number; down: number; degraded: number; maintenance: number }): string {
  const total = counts.up + counts.down + counts.degraded + counts.maintenance;
  if (total === 0) return GC.NO_DATA;
  if (counts.down > 0) return GC.DOWN;
  if (counts.degraded > 0) return GC.DEGRADED;
  if (counts.maintenance > 0) return GC.MAINTENANCE;
  return GC.UP;
}

/** ADR 0007's wording rule: proportion picks the phrasing, never the status. */
function summarise(counts: { up: number; down: number; degraded: number; maintenance: number }): string {
  const total = counts.up + counts.down + counts.degraded + counts.maintenance;
  switch (collapse(counts)) {
    case GC.DOWN:
      return (counts.down / total) * 100 >= 75
        ? PAGE_STATUS_MESSAGES.MAJOR_OUTAGE
        : PAGE_STATUS_MESSAGES.PARTIAL_OUTAGE;
    case GC.DEGRADED:
      return (counts.degraded / total) * 100 >= 75
        ? PAGE_STATUS_MESSAGES.DEGRADED_PERFORMANCE
        : PAGE_STATUS_MESSAGES.PARTIAL_DEGRADED;
    case GC.MAINTENANCE:
      return PAGE_STATUS_MESSAGES.UNDER_MAINTENANCE;
    case GC.UP:
      return PAGE_STATUS_MESSAGES.ALL_OPERATIONAL;
    default:
      return PAGE_STATUS_MESSAGES.NO_DATA;
  }
}

/** A declared row's communication value, inferring it for pre-C2 rows. */
function declared(row: { component_impact: string | null; monitor_impact: string | null }): ComponentImpact {
  return isComponentImpact(row.component_impact)
    ? row.component_impact
    : componentImpactFromMonitorImpact(row.monitor_impact);
}

/**
 * Derives every component's status and the page's, from values already fetched.
 *
 * Pure, so the precedence is testable without a database - which matters more
 * here than almost anywhere else in the codebase, because this is the function
 * that decides what a customer is told.
 */
export function derivePageStatus(args: {
  monitorTags: string[];
  latest: LatestStatus[];
  incidentImpacts: Array<{
    monitor_tag: string;
    monitor_impact: string | null;
    component_impact: string | null;
    impact_override: string | null;
  }>;
  maintenanceImpacts: Array<{ monitor_tag: string; monitor_impact: string | null; component_impact: string | null }>;
  /** The dependency graph (C3). Absent means no rollup, as before. */
  rollup?: {
    edges: DependencyEdge[];
    settings: RollupSetting[];
    /** Tags whose own status already is a rollup - GROUP monitors. */
    selfRollingTags?: Set<string>;
    nowSeconds: number;
  };
}): PageStatus {
  const latestByTag = new Map(args.latest.map((l) => [l.monitor_tag, l.status ?? null]));

  const overrides = new Map<string, ComponentImpact>();
  const fromIncidents = new Map<string, ComponentImpact>();
  for (const row of args.incidentImpacts) {
    if (isComponentImpact(row.impact_override)) {
      const current = overrides.get(row.monitor_tag);
      overrides.set(
        row.monitor_tag,
        current ? worstComponentImpact([current, row.impact_override]) : row.impact_override,
      );
      continue;
    }
    const impact = declared(row);
    const current = fromIncidents.get(row.monitor_tag);
    fromIncidents.set(row.monitor_tag, current ? worstComponentImpact([current, impact]) : impact);
  }

  const fromMaintenances = new Map<string, ComponentImpact>();
  for (const row of args.maintenanceImpacts) {
    const impact = declared(row);
    const current = fromMaintenances.get(row.monitor_tag);
    fromMaintenances.set(row.monitor_tag, current ? worstComponentImpact([current, impact]) : impact);
  }

  const components: ComponentStatus[] = [];
  const counts = { up: 0, down: 0, degraded: 0, maintenance: 0 };

  for (const tag of args.monitorTags) {
    let impact: ComponentImpact;
    let source: ComponentStatus["source"];

    // The precedence, in order. An override wins outright - that is what an
    // override is for - and each later rule only runs because the earlier ones
    // declared nothing.
    if (overrides.has(tag)) {
      impact = overrides.get(tag)!;
      source = "override";
    } else if (fromIncidents.has(tag)) {
      impact = fromIncidents.get(tag)!;
      source = "incident";
    } else if (fromMaintenances.has(tag)) {
      impact = fromMaintenances.get(tag)!;
      source = "maintenance";
      // C3 slots in here: else the worst of this component's children.
    } else {
      const status = latestByTag.get(tag);
      // A monitor that has never reported contributes to no count, which is what
      // makes `total === 0` reachable and therefore NO_DATA reachable. Defaulting
      // it to OPERATIONAL here would report a monitor that stopped reporting as
      // healthy - the exact failure ADR 0007 says a status page must not have.
      if (status === undefined || status === null) {
        // Counted by nobody: a monitor that has never reported contributes to no
        // bucket, which is what keeps NO_DATA reachable. Marked `silent` so the
        // recount after a rollup can tell it apart from a genuinely operational
        // component and keep leaving it out.
        components.push({
          monitor_tag: tag,
          component_impact: "OPERATIONAL",
          source: "silent",
          monitor_impact: null,
        });
        continue;
      }
      impact = componentImpactFromMonitorImpact(status === GC.UP ? null : status);
      source = "monitoring";
    }

    components.push({
      monitor_tag: tag,
      component_impact: impact,
      source,
      monitor_impact: monitorImpactFor(impact),
    });

    switch (monitorImpactFor(impact)) {
      case GC.DOWN:
        counts.down++;
        break;
      case GC.DEGRADED:
        counts.degraded++;
        break;
      case GC.MAINTENANCE:
        counts.maintenance++;
        break;
      default:
        counts.up++;
    }
  }

  // C3's slot, and the reason it sits *after* the per-component pass rather than
  // inside it: a rollup needs every child already resolved, and the loop above
  // resolves components in page order, which is not dependency order. Applying
  // the graph afterwards over the finished map is what lets a child that appears
  // later on the page still reach its parent.
  //
  // A component that is not on this page has no entry in the map and resolves to
  // OPERATIONAL inside the walk. That is a real limitation and it is the honest
  // one: this function is given a page, and a page cannot roll up a component it
  // does not contain without silently reporting on something it does not show.
  if (args.rollup) {
    const own = new Map(components.map((c) => [c.monitor_tag, c.component_impact]));
    const rolled = applyRollup({
      edges: args.rollup.edges,
      settings: args.rollup.settings,
      own,
      selfRollingTags: args.rollup.selfRollingTags,
      nowSeconds: args.rollup.nowSeconds,
    });

    // Recounted from scratch, because a rollup can move a component in either
    // direction and the counts drive the page headline.
    counts.up = 0;
    counts.down = 0;
    counts.degraded = 0;
    counts.maintenance = 0;
    for (const component of components) {
      const after = rolled.get(component.monitor_tag) ?? component.component_impact;
      // A silent component that the graph did not move stays out of the counts,
      // exactly as it was before the rollup ran.
      if (component.source === "silent" && after === component.component_impact) continue;
      if (after !== component.component_impact) {
        component.component_impact = after;
        component.monitor_impact = monitorImpactFor(after);
        component.source = "rollup";
      }
      switch (monitorImpactFor(component.component_impact)) {
        case GC.DOWN:
          counts.down++;
          break;
        case GC.DEGRADED:
          counts.degraded++;
          break;
        case GC.MAINTENANCE:
          counts.maintenance++;
          break;
        default:
          counts.up++;
      }
    }
  }

  return {
    component_impact: worstComponentImpact(components.map((c) => c.component_impact)),
    status: collapse(counts),
    statusSummary: summarise(counts),
    statusClass: statusBgClass(collapse(counts)),
    components,
  };
}

/**
 * Derives a page's status, fetching what it needs.
 *
 * The three reads are unconditional on purpose. The rendering path fetches
 * incidents and maintenances only when the page is configured to display them,
 * and reusing those would make "hide the incident list" quietly mean "report the
 * page healthy".
 */
export async function getPageStatus(
  monitorTags: string[],
  timestamp: number,
  /**
   * The latest sample per monitor, when the caller already has it.
   *
   * The page renderer fetches exactly this to draw its monitor list, and this
   * function would otherwise ask for it a second time on every page load. The
   * two declared-impact queries are always issued here, because those are the
   * ones the renderer fetches conditionally.
   */
  latest?: LatestStatus[],
): Promise<PageStatus> {
  if (monitorTags.length === 0) {
    return derivePageStatus({ monitorTags: [], latest: [], incidentImpacts: [], maintenanceImpacts: [] });
  }
  const [resolvedLatest, incidentImpacts, maintenanceImpacts, edges, settings, groupMonitors] = await Promise.all([
    latest ? Promise.resolve(latest) : (db.getLatestMonitoringDataAllActive(monitorTags) as Promise<LatestStatus[]>),
    db.getDeclaredIncidentImpacts(timestamp, monitorTags),
    db.getDeclaredMaintenanceImpacts(timestamp, monitorTags),
    db.getAllDependencies(),
    db.getAllRollupSettings(),
    // GROUP monitors already produce their status from their members at check
    // time, so the rollup must skip them or it would apply a second, different
    // rule to the same members. See incidents/rollup.ts.
    db.getMonitorsByType("GROUP"),
  ]);

  return derivePageStatus({
    monitorTags,
    latest: resolvedLatest,
    incidentImpacts,
    maintenanceImpacts,
    rollup: {
      edges,
      settings,
      selfRollingTags: new Set(groupMonitors.map((m: { tag: string }) => m.tag)),
      nowSeconds: timestamp,
    },
  });
}
