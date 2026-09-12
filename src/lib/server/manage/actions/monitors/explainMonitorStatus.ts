import db from "$lib/server/db/db.js";
import { derivePageStatus, type LatestStatus } from "$lib/server/incidents/pageStatus.js";
import { descendants } from "$lib/server/incidents/dependencyView.js";
import { explainComponent, type ComponentExplanation } from "$lib/server/incidents/explain.js";
import { GetMonitorsParsed } from "$lib/server/controllers/monitorsController.js";
import type { DependencyEdge, RollupSetting } from "$lib/server/incidents/rollup.js";
import type { ComponentImpact } from "$lib/server/incidents/impact.js";
import { GetMinuteStartNowTimestampUTC } from "$lib/server/tool.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  monitor_tag?: string;
}

/**
 * Why one monitor reads the way it does.
 *
 * The same explanation the Pages panel gives, asked about a single component,
 * because that is where the question actually gets asked: an operator looking at
 * "Major System Outage" on a monitor wants to know what that monitor's check
 * said, not how the page arrived at a headline.
 *
 * **Derived over the monitor and everything below it**, which is the same
 * closure `getMonitorDependencyView` uses. A rollup needs its children resolved,
 * so deriving over the monitor alone would report it operational whenever the
 * graph is what moved it - the exact case this is most often opened for.
 */
export default {
  action: "explainMonitorStatus",
  handler: async (data: Payload): Promise<ComponentExplanation & { dependencies: string[] }> => {
    const tag = String(data.monitor_tag ?? "").trim();
    if (!tag) throw new ActionError(400, "monitor_tag is required");

    // Scoped, so a tag belonging to another org simply is not found.
    const monitor = await db.getMonitorsByTag(tag);
    if (!monitor) throw new ActionError(404, "That monitor does not exist");

    const nowSeconds = GetMinuteStartNowTimestampUTC();
    const [edges, settings, groupMonitors, monitors] = await Promise.all([
      db.getAllDependencies() as Promise<DependencyEdge[]>,
      db.getAllRollupSettings() as Promise<RollupSetting[]>,
      db.getMonitorsByType("GROUP") as Promise<Array<{ tag: string }>>,
      GetMonitorsParsed({ status: "ACTIVE" }),
    ]);

    const childrenOf = new Map<string, DependencyEdge[]>();
    for (const edge of edges) {
      const list = childrenOf.get(edge.parent_monitor_tag) ?? [];
      list.push(edge);
      childrenOf.set(edge.parent_monitor_tag, list);
    }
    const closureTags = [tag, ...descendants(childrenOf, [tag])];

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

    const self = derived.components.find((component) => component.monitor_tag === tag);
    if (!self) throw new ActionError(404, "That monitor produced no component status");

    const nameByTag = new Map(monitors.map((m) => [m.tag, m.name]));
    const displayable = new Set(monitors.filter((m) => m.is_hidden !== "YES").map((m) => m.tag));
    const resolved = new Map<string, ComponentImpact>(
      derived.components.map((component) => [component.monitor_tag, component.component_impact]),
    );

    return {
      ...explainComponent(self, {
        nameByTag,
        latest,
        incidentImpacts,
        maintenanceImpacts,
        edges,
        settings,
        resolved,
        displayable,
        nowSeconds,
      }),
      // What this monitor depends on, named where it may be named, so the panel
      // can say "nothing it depends on is in trouble" rather than being silent
      // about a graph the operator may not remember configuring.
      dependencies: (childrenOf.get(tag) ?? [])
        .filter((edge) => displayable.has(edge.child_monitor_tag))
        .map((edge) => nameByTag.get(edge.child_monitor_tag) ?? edge.child_monitor_tag),
    };
  },
} satisfies ActionDefinition<Payload>;
