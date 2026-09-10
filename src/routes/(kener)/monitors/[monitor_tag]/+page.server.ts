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

  const monitorTags = [monitor_tag];

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
    for (const parsedMonitor of parsedExtendedMonitors) {
      if (parsedMonitor.monitor_type !== "GROUP") continue;

      const groupData = parsedMonitor.type_data as GroupMonitorTypeData;
      if (!groupData?.monitors || !Array.isArray(groupData.monitors)) continue;

      monitorGroupMembersByTag[parsedMonitor.tag] = groupData.monitors.map((member) => member.tag);
    }
  }

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
      maxDays,
      monitorSharingOptions: {
        showShareBadgeMonitor: monitor.monitor_settings_json?.sharing_options?.showShareBadgeMonitor ?? true,
        showShareEmbedMonitor: monitor.monitor_settings_json?.sharing_options?.showShareEmbedMonitor ?? true,
      },
    },
  };
};
