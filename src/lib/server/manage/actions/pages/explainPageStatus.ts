import db from "$lib/server/db/db.js";
import { derivePageStatus, type LatestStatus } from "$lib/server/incidents/pageStatus.js";
import { explainComponent, explainHeadline, type PageExplanation } from "$lib/server/incidents/explain.js";
import { GetMonitorsParsed } from "$lib/server/controllers/monitorsController.js";
import type { DependencyEdge, RollupSetting } from "$lib/server/incidents/rollup.js";
import type { ComponentImpact } from "$lib/server/incidents/impact.js";
import { GetMinuteStartNowTimestampUTC } from "$lib/server/tool.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  page_id?: number;
}

/**
 * Why a status page says what it says.
 *
 * The panel exists because `ComponentStatus.source` has recorded which rule won
 * since C2b and nothing ever showed it, so answering "why is this page not
 * green" meant reading the derivation and then querying four tables by hand.
 *
 * **It runs the real derivation.** Not a copy of it, not a summary of the stored
 * result: the same `derivePageStatus` the public page runs, over the same rows,
 * at one instant. An explanation assembled any other way would eventually
 * explain something the page is not saying, and a confident wrong explanation of
 * a correct status is worse than no panel.
 *
 * The monitor set is the page's visible one, for the same reason: a component
 * hidden from the page takes part in the computation but is not on it, and an
 * explanation that listed it would be answering about a different page.
 */
export default {
  action: "explainPageStatus",
  handler: async (data: Payload): Promise<PageExplanation & { page_name: string }> => {
    const pageId = Number(data.page_id);
    if (!Number.isFinite(pageId)) throw new ActionError(400, "page_id is required");

    // Scoped, so a page belonging to another org is simply not found.
    const page = (await db.getAllPages()).find((p) => p.id === pageId);
    if (!page) throw new ActionError(404, "That page does not exist");

    const nowSeconds = GetMinuteStartNowTimestampUTC();
    const pageMonitors = await db.getPageMonitorsExcludeHidden(pageId);
    const monitorTags = pageMonitors.map((row) => row.monitor_tag);

    if (monitorTags.length === 0) {
      return {
        page_name: page.page_title,
        headline: "",
        counts: { up: 0, down: 0, degraded: 0, maintenance: 0 },
        headline_reason: "This page has no visible components, so there is nothing to derive a status from.",
        components: [],
      };
    }

    const [latest, incidentImpacts, maintenanceImpacts, edges, settings, groupMonitors, monitors] = await Promise.all([
      db.getLatestMonitoringDataAllActive(monitorTags) as Promise<LatestStatus[]>,
      db.getDeclaredIncidentImpacts(nowSeconds, monitorTags),
      db.getDeclaredMaintenanceImpacts(nowSeconds, monitorTags),
      db.getAllDependencies() as Promise<DependencyEdge[]>,
      db.getAllRollupSettings() as Promise<RollupSetting[]>,
      db.getMonitorsByType("GROUP") as Promise<Array<{ tag: string }>>,
      GetMonitorsParsed({ status: "ACTIVE" }),
    ]);

    const derived = derivePageStatus({
      monitorTags,
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

    const nameByTag = new Map(monitors.map((monitor) => [monitor.tag, monitor.name]));
    // Only monitors an operator can see named. A hidden dependency moves the
    // status it always moved and is still not named, which is C3b's rule and
    // holds here too: this panel explains the page, not the whole graph.
    const displayable = new Set(monitors.filter((monitor) => monitor.is_hidden !== "YES").map((m) => m.tag));
    const resolved = new Map<string, ComponentImpact>(
      derived.components.map((component) => [component.monitor_tag, component.component_impact]),
    );

    const counts = { up: 0, down: 0, degraded: 0, maintenance: 0 };
    const components = derived.components.map((component) =>
      explainComponent(component, {
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
    );

    // Recounted from the components rather than returned by the derivation,
    // because the counts are the headline's evidence and printing a number the
    // reader cannot check against the list above it defeats the whole panel.
    for (const component of components) {
      if (!component.counted) continue;
      switch (component.impact) {
        case "MAJOR_OUTAGE":
          counts.down++;
          break;
        case "PARTIAL_OUTAGE":
        case "DEGRADED_PERFORMANCE":
          counts.degraded++;
          break;
        case "UNDER_MAINTENANCE":
          counts.maintenance++;
          break;
        default:
          counts.up++;
      }
    }

    return {
      page_name: page.page_title,
      headline: derived.statusSummary,
      counts,
      headline_reason: explainHeadline(derived.statusSummary, counts),
      components,
    };
  },
} satisfies ActionDefinition<Payload>;
