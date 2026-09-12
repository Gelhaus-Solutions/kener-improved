import GC from "../../global-constants.js";
import { PAGE_STATUS_MESSAGES } from "../../global-constants.js";
import { componentImpactSummary, type ComponentStatus, type LatestStatus } from "./pageStatus.js";
import { activeOverride, type DependencyEdge, type RollupSetting } from "./rollup.js";
import { inheritedFrom } from "./dependencyView.js";
import { liveComponentImpactFor, type ComponentImpact } from "./impact.js";

/**
 * Why a page says what it says.
 *
 * `ComponentStatus.source` has recorded which rule won since C2b - override,
 * incident, maintenance, rollup, monitoring, silent - and nothing has ever shown
 * it. So "why is this page not green" was answered by reading `derivePageStatus`
 * and then querying four tables by hand, which is how a five second question
 * became a twenty minute one.
 *
 * **This annotates a derivation, it never performs one.** Everything here is
 * given the components `derivePageStatus` already produced and the same rows it
 * was given. A second implementation that recomputed the answer would be a
 * second thing to keep in step, and the first time the two disagreed the
 * explanation would be confidently wrong about a correct status, which is worse
 * than having none.
 */

export interface DeclaredEvent {
  id: number;
  title: string | null;
  impact: string;
}

export interface ComponentExplanation {
  monitor_tag: string;
  name: string;
  impact: ComponentImpact;
  /** The page's own wording for this one component. */
  summary: string;
  source: ComponentStatus["source"];
  /** One sentence saying why, in the words an operator needs. */
  reason: string;
  /** The monitor's own latest published sample, and what its check observed. */
  own_status: string | null;
  own_check: string | null;
  /** Open incidents declaring an impact on this component. */
  incidents: DeclaredEvent[];
  /** Ongoing maintenances declaring one. */
  maintenances: DeclaredEvent[];
  /** Names of the children a rolled-up status came from. */
  inherited_from: string[];
  /** A live manual pin, which outranks everything below it. */
  pin: { impact: string; expires_at: number | null } | null;
  /**
   * Whether this component is counted in the headline's proportions.
   *
   * A component that has never reported is deliberately counted by nobody, and
   * an operator looking at a page whose headline ignores one of its rows needs
   * that said rather than inferred.
   */
  counted: boolean;
}

export interface PageExplanation {
  headline: string;
  counts: { up: number; down: number; degraded: number; maintenance: number };
  /** Why the headline is worded the way it is, including ADR 0007's 75% rule. */
  headline_reason: string;
  components: ComponentExplanation[];
}

const impactWord = (impact: string): string => impact.toLowerCase().replace(/_/g, " ");

/**
 * The headline's wording, explained.
 *
 * ADR 0007's 75% threshold is a *wording* rule: it chooses between "Major" and
 * "Partial" and can never turn a down bucket into an up one. It is also the
 * single most confusing thing about a Kener page from the outside, because one
 * component of twenty being down reads as "Partial System Outage" and nobody
 * can see the arithmetic. So the arithmetic is printed.
 */
export function explainHeadline(
  headline: string,
  counts: { up: number; down: number; degraded: number; maintenance: number },
): string {
  const total = counts.up + counts.down + counts.degraded + counts.maintenance;
  if (total === 0) return "No component has ever reported, so the page has no status to show.";

  const share = (n: number) => Math.round((n / total) * 100);
  const plural = (n: number) => (n === 1 ? "" : "s");
  const verb = (n: number) => (n === 1 ? "is" : "are");

  if (headline === PAGE_STATUS_MESSAGES.ALL_OPERATIONAL) {
    return `All ${total} counted component${plural(total)} ${verb(total)} operational.`;
  }
  if (headline === PAGE_STATUS_MESSAGES.UNDER_MAINTENANCE) {
    return `${counts.maintenance} of ${total} component${plural(total)} ${verb(counts.maintenance)} under maintenance and none is down or degraded.`;
  }
  if (counts.down > 0) {
    const reached = share(counts.down) >= 75;
    return `${counts.down} of ${total} component${plural(total)} ${verb(counts.down)} down, which is ${share(counts.down)}%. ${
      reached
        ? "At or above 75% the page says major rather than partial."
        : "Below 75% the page says partial rather than major, which is a wording rule and never changes whether a component is down."
    }`;
  }
  const reached = share(counts.degraded) >= 75;
  return `${counts.degraded} of ${total} component${plural(total)} ${verb(counts.degraded)} degraded, which is ${share(counts.degraded)}%. ${
    reached
      ? "At or above 75% the page says degraded rather than partially degraded."
      : "Below 75% the page says partially degraded."
  }`;
}

/** The rows a component's own explanation is assembled from. */
export interface ExplainInputs {
  nameByTag: Map<string, string>;
  latest: readonly LatestStatus[];
  incidentImpacts: ReadonlyArray<{
    id: number;
    title: string | null;
    monitor_tag: string;
    monitor_impact: string | null;
    component_impact: string | null;
    impact_override: string | null;
  }>;
  maintenanceImpacts: ReadonlyArray<{
    id: number;
    title: string | null;
    monitor_tag: string;
    monitor_impact: string | null;
    component_impact: string | null;
  }>;
  edges: readonly DependencyEdge[];
  settings: readonly RollupSetting[];
  resolved: Map<string, ComponentImpact>;
  displayable: Set<string>;
  nowSeconds: number;
}

/**
 * One component, annotated with the evidence for its status.
 *
 * The branches follow `derivePageStatus`'s precedence exactly, because the
 * `source` it recorded is what selects them: override, then incident, then
 * maintenance, then the rollup, then the monitor's own check.
 */
export function explainComponent(component: ComponentStatus, inputs: ExplainInputs): ComponentExplanation {
  const tag = component.monitor_tag;
  const row = inputs.latest.find((l) => l.monitor_tag === tag);
  const ownStatus = row?.status ?? null;
  const ownCheck = row?.raw_status ?? null;

  const incidents = inputs.incidentImpacts
    .filter((i) => i.monitor_tag === tag)
    .map((i) => ({
      id: i.id,
      title: i.title,
      impact: i.impact_override ?? i.component_impact ?? i.monitor_impact ?? "",
    }));
  const maintenances = inputs.maintenanceImpacts
    .filter((m) => m.monitor_tag === tag)
    .map((m) => ({ id: m.id, title: m.title, impact: m.component_impact ?? m.monitor_impact ?? "" }));

  const setting = inputs.settings.find((s) => s.monitor_tag === tag);
  const pinned = activeOverride(setting, inputs.nowSeconds);

  const children = inputs.edges.filter((edge) => edge.parent_monitor_tag === tag);
  const inherited =
    component.source === "rollup" && !pinned
      ? inheritedFrom({
          edges: children,
          resolved: inputs.resolved,
          displayable: inputs.displayable,
          ownImpact: liveComponentImpactFor(ownCheck ?? ownStatus),
        }).map((childTag) => inputs.nameByTag.get(childTag) ?? childTag)
      : [];

  return {
    monitor_tag: tag,
    name: inputs.nameByTag.get(tag) ?? tag,
    impact: component.component_impact,
    summary: componentImpactSummary(component.component_impact, component.source === "silent"),
    source: component.source,
    reason: reasonFor(component, { incidents, maintenances, inherited, pinned, ownStatus, ownCheck }),
    own_status: ownStatus,
    own_check: ownCheck,
    incidents,
    maintenances,
    inherited_from: inherited,
    pin: pinned ? { impact: pinned, expires_at: setting?.manual_override_expires_at ?? null } : null,
    counted: component.source !== "silent",
  };
}

function reasonFor(
  component: ComponentStatus,
  evidence: {
    incidents: DeclaredEvent[];
    maintenances: DeclaredEvent[];
    inherited: string[];
    pinned: ComponentImpact | null;
    ownStatus: string | null;
    ownCheck: string | null;
  },
): string {
  const named = (events: DeclaredEvent[]) =>
    events.map((e) => e.title || `#${e.id}`).join(", ") || "an event with no title";

  switch (component.source) {
    case "override":
      return `An open incident overrides this component to ${impactWord(component.component_impact)}: ${named(evidence.incidents)}. An override outranks everything else, including the monitor's own check.`;
    case "incident":
      return `An open incident declares ${impactWord(component.component_impact)} on this component: ${named(evidence.incidents)}.`;
    case "maintenance":
      return `An ongoing maintenance declares ${impactWord(component.component_impact)} on this component: ${named(evidence.maintenances)}.`;
    case "rollup":
      if (evidence.pinned) {
        return `An operator has pinned this component at ${impactWord(evidence.pinned)}. That is a typed value, not something the monitoring found.`;
      }
      return evidence.inherited.length > 0
        ? `Inherited from ${evidence.inherited.join(", ")}. Its own check last reported ${evidence.ownCheck ?? evidence.ownStatus ?? "nothing"}.`
        : `A dependency is worse than this component's own check, which last reported ${evidence.ownCheck ?? evidence.ownStatus ?? "nothing"}. The dependency is hidden or inactive, so it is not named here.`;
    case "silent":
      return "This component has never reported. It is shown as having no data and is left out of the headline's arithmetic, rather than counted as healthy.";
    default:
      return evidence.ownStatus === GC.UP
        ? "Its own check last reported UP, and nothing is declared against it."
        : `Its own check last reported ${evidence.ownStatus ?? "nothing"}, and nothing is declared against it.`;
  }
}
