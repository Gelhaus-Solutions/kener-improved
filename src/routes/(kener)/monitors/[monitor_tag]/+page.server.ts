import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import db from "$lib/server/db/db";
import {
  GetOngoingIncidentsForMonitorList,
  GetResolvedIncidentsForMonitorList,
  GetOngoingMaintenanceEventsForMonitorList,
  GetPastMaintenanceEventsForMonitorList,
  GetUpcomingMaintenanceEventsForMonitorList,
} from "$lib/server/controllers/dashboardController.js";
import { GetNowTimestampUTC, UptimeCalculator } from "$lib/server/tool";
import GC from "$lib/global-constants.js";
import { ParseLatency } from "$lib/clientTools";
import { componentImpactSummary, componentImpactTextClass } from "$lib/server/incidents/pageStatus";
import { getMonitorDependencyView } from "$lib/server/incidents/dependencyView";
import { GetMonitorsParsed } from "$lib/server/controllers/monitorsController";
import { ResolvePublicMonitorTag } from "$lib/server/controllers/publicMonitorResolver";
import type { GroupMonitorTypeData } from "$lib/server/types/monitor";

/**
 * The window a published SLO figure covers, as a token that needs no translating.
 *
 * Derived from the evaluation's own `window_start` rather than from the clock,
 * so a figure computed just before midnight on 30 September still says
 * `2026-09` when it is read a minute later.
 */
function publicWindowLabel(
  target: { window_type: string; window_days: number | null; calendar_period: string | null },
  windowStart: number,
): string {
  if (target.window_type !== "CALENDAR") return `${target.window_days ?? 30}d (UTC)`;
  const start = new Date(windowStart * 1000);
  const year = start.getUTCFullYear();
  if (target.calendar_period === "YEAR") return `${year} (UTC)`;
  if (target.calendar_period === "QUARTER") return `${year}-Q${Math.floor(start.getUTCMonth() / 3) + 1} (UTC)`;
  return `${year}-${String(start.getUTCMonth() + 1).padStart(2, "0")} (UTC)`;
}

export const load: PageServerLoad = async ({ params, parent }) => {
  const { monitor_tag } = params;
  const parentData = await parent();
  // I3e: the URL carries the monitor's per-org slug. Identical to the tag for
  // the default org, so existing links are unaffected.
  const resolvedTag = (await ResolvePublicMonitorTag(monitor_tag)) ?? monitor_tag;
  // Validate monitor exists
  const monitors = await GetMonitorsParsed({ tag: resolvedTag, status: "ACTIVE", is_hidden: "NO" });
  if (!monitors || monitors.length === 0) {
    throw error(404, { message: "Monitor not found" });
  }
  const monitor = monitors[0];
  if (!monitor) {
    throw error(404, { message: "Monitor not found" });
  }

  // Check if monitor is hidden
  if (monitor.is_hidden === "YES") {
    throw error(404, { message: "Monitor not found" });
  }

  // The *physical* tag, not the URL segment (KENER-127). The loader resolves the
  // slug a few lines up and then threw the result away here, so in an org with a
  // `tag_prefix` these three queries asked about a tag that does not exist and a
  // monitor in an active incident rendered a clean page with no incident on it.
  // Invisible on the default org, where slug and tag are the same string.
  const monitorTags = [monitor.tag];

  const eventSettings = parentData.eventDisplaySettings;
  const showInlineEvents = eventSettings.showInlineEvents === true;
  const [ongoingIncidents, ongoingMaintenances, upcomingMaintenances] = await Promise.all([
    showInlineEvents && eventSettings.incidents.enabled && eventSettings.incidents.ongoing.show
      ? GetOngoingIncidentsForMonitorList(monitorTags)
      : Promise.resolve([]),
    showInlineEvents && eventSettings.maintenances.enabled && eventSettings.maintenances.ongoing.show
      ? GetOngoingMaintenanceEventsForMonitorList(monitorTags)
      : Promise.resolve([]),
    showInlineEvents && eventSettings.maintenances.enabled && eventSettings.maintenances.upcoming.show
      ? GetUpcomingMaintenanceEventsForMonitorList(
          monitorTags,
          eventSettings.maintenances.upcoming.maxCount,
          eventSettings.maintenances.upcoming.daysInFuture,
        )
      : Promise.resolve([]),
  ]);

  const nowSeconds = GetNowTimestampUTC();

  // The timestamp and the latency still come from the monitor's own last sample:
  // both are facts about a check that ran, and neither is something a declared
  // incident or a dependency could sensibly supply.
  const lastStatus = await db.getLatestMonitoringData(monitor.tag);
  const lastSampleTimestamp = lastStatus ? lastStatus.timestamp : nowSeconds;
  const lastSampleLatency = lastStatus?.latency ?? 0;

  // The status, however, is derived exactly as the status page derives it:
  // declared incidents and maintenances first, then C3's dependency rollup.
  // Until now this page collapsed its own latest sample instead, so a component
  // the graph had moved read one way on the status page and another on its own -
  // and there was no way for a visitor to find out which was true.
  const dependencyView = await getMonitorDependencyView(monitor.tag, nowSeconds);

  //get status summary
  let extendedTags: string[] = [];
  let monitorGroupMembersByTag: Record<string, string[]> = {};
  if (monitor.monitor_type === "GROUP") {
    const groupData = monitor.type_data as GroupMonitorTypeData;
    const memberTags = groupData.monitors.map((m) => m.tag);
    extendedTags = extendedTags.concat(memberTags);
  }

  if (extendedTags.length > 0) {
    const parsedExtendedMonitors = await GetMonitorsParsed({ tags: extendedTags, status: "ACTIVE", is_hidden: "NO" });
    // KENER-126: this list is serialised into the page and the browser then asks
    // the bar endpoint for each tag in it. Taken straight from `type_data` it
    // published the tag of any hidden or inactive group member, which is how a
    // monitor an operator hid became reachable. Narrowed to the members that
    // survived the query above, which already applies the visibility filter.
    //
    // A GROUP monitor's own *status* still comes from every member, hidden ones
    // included, because that is what `groupCall` computed at check time. Hiding a
    // member conceals it; it does not remove it from the group.
    const visibleTags = new Set(parsedExtendedMonitors.map((m) => m.tag));
    extendedTags = extendedTags.filter((tag) => visibleTags.has(tag));
    for (const parsedMonitor of parsedExtendedMonitors) {
      if (parsedMonitor.monitor_type !== "GROUP") continue;

      const groupData = parsedMonitor.type_data as GroupMonitorTypeData;
      if (!groupData?.monitors || !Array.isArray(groupData.monitors)) continue;

      monitorGroupMembersByTag[parsedMonitor.tag] = groupData.monitors.map((member) => member.tag);
    }
  }

  // F1a: the published SLO panel.
  //
  // **Only targets that name this component directly**, and only the ones an
  // operator opted into publishing. A page- or category-scoped target measures
  // something wider than this page is about, and showing it here would attach a
  // figure to a component that is not the figure for that component.
  //
  // **Only four fields leave the server.** Every value a loader returns is
  // serialised into the HTML whether or not the template renders it, so the
  // filtering has to happen here. Burn rates in particular stay behind: they are
  // an operational signal about how fast a budget is being spent, and publishing
  // them tells a reader more about the provider's internal alerting than about
  // the service they are checking on.
  const publishedSloTargets = (await db.getSlaTargetsForMonitor(monitor.tag)).filter(
    (target) => target.show_on_public === "YES",
  );
  const sloEvaluationsByTarget = new Map(
    (await db.getSlaEvaluations(publishedSloTargets.map((target) => target.id))).map((row) => [row.sla_target_id, row]),
  );
  const publishedSlos = publishedSloTargets
    .map((target) => {
      const evaluation = sloEvaluationsByTarget.get(target.id);
      // A target created minutes ago has no evaluation yet. Publishing it with
      // nulls would render an empty row that looks like an outage.
      if (!evaluation || evaluation.uptime_percent === null) return null;
      return {
        name: target.name,
        objectivePercent: target.objective_percent,
        uptimePercent: evaluation.uptime_percent,
        budgetRemainingPercent: evaluation.budget_remaining_percent,
        // A locale-neutral token rather than an English sentence. This string
        // is rendered on a page that is translated into 24 languages, and
        // "Rolling 30 days" would be the one part of the panel stuck in
        // English. "30d (UTC)" and "2026-09 (UTC)" read the same everywhere and
        // need no locale key of their own.
        window: publicWindowLabel(target, evaluation.window_start),
      };
    })
    .filter((slo) => slo !== null);

  let maxDays: number = parentData.isMobile
    ? GC.DEFAULT_STATUS_HISTORY_DAYS_MOBILE
    : GC.DEFAULT_STATUS_HISTORY_DAYS_DESKTOP;
  if (monitor.monitor_settings_json?.monitor_status_history_days) {
    maxDays = parentData.isMobile
      ? monitor.monitor_settings_json.monitor_status_history_days.mobile || GC.DEFAULT_STATUS_HISTORY_DAYS_MOBILE
      : monitor.monitor_settings_json.monitor_status_history_days.desktop || GC.DEFAULT_STATUS_HISTORY_DAYS_DESKTOP;
  }
  return {
    ...{
      monitorTag: monitor_tag,
      monitorName: monitor.name,
      monitorImage: monitor.image,
      monitorDescription: monitor.description,
      monitorId: monitor.id,
      monitorLastStatus: componentImpactSummary(dependencyView.impact, dependencyView.silent),
      textClass: componentImpactTextClass(dependencyView.impact, dependencyView.silent),
      // Only when the graph is what moved the headline. Any other time the two
      // agree, and a second status line saying the same thing is noise.
      monitorOwnStatus: dependencyView.source === "rollup" ? dependencyView.ownStatus : null,
      inheritedFrom: dependencyView.inheritedFrom,
      dependsOnTags: dependencyView.dependsOn.map((node) => node.monitor_tag),
      partOfTags: dependencyView.partOf.map((node) => node.monitor_tag),
      monitorLastStatusTimestamp: lastSampleTimestamp,
      monitorLastLatency: ParseLatency(lastSampleLatency),
      ongoingIncidents,
      ongoingMaintenances,
      upcomingMaintenances,
      externalUrl: monitor.external_url,
      extendedTags,
      monitorGroupMembersByTag,
      publishedSlos,
      maxDays,
      monitorSharingOptions: {
        showShareBadgeMonitor: monitor.monitor_settings_json?.sharing_options?.showShareBadgeMonitor ?? true,
        showShareEmbedMonitor: monitor.monitor_settings_json?.sharing_options?.showShareEmbedMonitor ?? true,
      },
    },
  };
};
