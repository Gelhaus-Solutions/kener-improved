import db from "../db/db.js";
import { GetMinuteStartNowTimestampUTC, BeginningOfMinute, BeginningOfDay } from "../tool.js";
import { GetPageByPathWithMonitors, GetLatestMonitoringDataAllActive } from "./controller.js";
import { GetMonitorsParsed } from "./monitorsController.js";
import { getPageStatus, type LatestStatus, type PageStatus } from "../incidents/pageStatus.js";

import type {
  IncidentRecord,
  IncidentCommentRecord,
  IncidentForMonitorListWithComments,
  MaintenanceEventsMonitorList,
  PageRecordTyped,
  TimestampStatusCount,
  PageSettingsType,
  IncidentMonitorDetailRecord,
} from "../types/db.js";
import type { GroupMonitorTypeData } from "../types/monitor.js";
import GC from "../../global-constants.js";
import type { LayoutServerData } from "./layoutController.js";
import type { NotificationEvent } from "../../types/notifications.js";

export type { NotificationEvent };

// Default page settings
const defaultPageSettings: PageSettingsType = {
  monitor_status_history_days: {
    desktop: GC.DEFAULT_STATUS_HISTORY_DAYS_DESKTOP,
    mobile: GC.DEFAULT_STATUS_HISTORY_DAYS_MOBILE,
  },
  monitor_layout_style: GC.DEFAULT_MONITOR_LAYOUT_STYLE,
  // G1/G2, both off: see the note on the two interfaces. Every page that exists
  // today renders exactly as it did before these settings were added.
  status_filter: { enabled: false },
  group_display: { mode: "none", collapsed_by_default: false, show_group_summary: true },
  // G3, an opt-out: a page is listed in the switcher unless it says otherwise.
  switcher: { listed: true },
};

/**
 * Merges stored page settings over the defaults.
 *
 * **The nested blocks are merged one level down, and the top-level spread is why
 * they have to be.** `{ ...defaults, ...parsed }` replaces a nested object
 * wholesale, so a page stored before a field was added to `group_display` would
 * come back missing that field rather than defaulted - and the value read from it
 * would be `undefined`, not the default the rest of the code assumes. Spelling
 * the two new blocks out here costs three lines and removes a whole class of
 * "why is this page rendering with no summary" that only appears on pages saved
 * by an older build.
 */
function mergePageSettings(parsed: Partial<PageSettingsType> | null | undefined): PageSettingsType {
  const merged: PageSettingsType = { ...defaultPageSettings, ...(parsed ?? {}) };
  merged.status_filter = { ...defaultPageSettings.status_filter, ...(parsed?.status_filter ?? {}) };
  merged.group_display = { ...defaultPageSettings.group_display, ...(parsed?.group_display ?? {}) };
  merged.switcher = { ...defaultPageSettings.switcher, ...(parsed?.switcher ?? {}) };
  merged.monitor_status_history_days = {
    ...defaultPageSettings.monitor_status_history_days,
    ...(parsed?.monitor_status_history_days ?? {}),
  };
  return merged;
}

export interface NotificationPayload {
  notifications: NotificationEvent[];
}

// Type for incident with comments
export type IncidentWithComments = IncidentRecord & {
  comments: IncidentCommentRecord[];
};

//ongoing maintenance function using maintenance tables
const GetOngoingMaintenances = async (
  monitor_tags: string[],
  nowTs: number,
): Promise<MaintenanceEventsMonitorList[]> => {
  const ongoingMaintenances = await db.getOngoingMaintenanceEventsForMonitorList(nowTs, monitor_tags);
  return ongoingMaintenances;
};

//given array of monitor tags, get ongoing incidents for dashboard
export const GetOngoingIncidentsForMonitorList = async (
  monitor_tags: string[],
): Promise<IncidentForMonitorListWithComments[]> => {
  const now = GetMinuteStartNowTimestampUTC();
  const ongoingIncidents = await db.getOngoingIncidentsForMonitorListWithComments(now, monitor_tags);
  return ongoingIncidents;
};

//given array of monitor tags, get recently resolved incidents for dashboard
export const GetResolvedIncidentsForMonitorList = async (
  monitor_tags: string[],
  limit: number = 5,
  daysInPast: number = 7,
): Promise<IncidentForMonitorListWithComments[]> => {
  const now = GetMinuteStartNowTimestampUTC();
  return await db.getResolvedIncidentsForMonitorListWithComments(now, monitor_tags, limit, daysInPast);
};

// ============ Maintenance Events for Monitor List ============

/**
 * Get ongoing maintenance events for a list of monitors
 * Returns maintenance events that are currently in progress
 */
export const GetOngoingMaintenanceEventsForMonitorList = async (
  monitor_tags: string[],
): Promise<MaintenanceEventsMonitorList[]> => {
  const now = GetMinuteStartNowTimestampUTC();
  const ongoingMaintenances = await db.getOngoingMaintenanceEventsForMonitorList(now, monitor_tags);
  return ongoingMaintenances;
};

/**
 * Get past/completed maintenance events for a list of monitors
 * Returns maintenance events that ended within the specified days
 */
export const GetPastMaintenanceEventsForMonitorList = async (
  monitor_tags: string[],
  limit: number = 5,
  daysInPast: number = 7,
): Promise<MaintenanceEventsMonitorList[]> => {
  const now = GetMinuteStartNowTimestampUTC();
  const pastMaintenances = await db.getPastMaintenanceEventsForMonitorList(now, monitor_tags, limit, daysInPast);
  return pastMaintenances;
};

/**
 * Get upcoming maintenance events for a list of monitors
 * Returns scheduled maintenance events within the specified days
 */
export const GetUpcomingMaintenanceEventsForMonitorList = async (
  monitor_tags: string[],
  limit: number = 5,
  daysInFuture: number = 7,
): Promise<MaintenanceEventsMonitorList[]> => {
  const now = GetMinuteStartNowTimestampUTC();
  const upcomingMaintenances = await db.getUpcomingMaintenanceEventsForMonitorList(
    now,
    monitor_tags,
    limit,
    daysInFuture,
  );
  return upcomingMaintenances;
};

// ============ Incident Detail Functions ============

/**
 * Get incident by ID
 */
export const GetIncidentById = async (id: number): Promise<Omit<IncidentRecord, "incident_source"> | undefined> => {
  return await db.getIncidentById(id);
};

/**
 * Get incident comments by incident ID
 */
export const GetIncidentCommentsByIncidentId = async (incident_id: number): Promise<IncidentCommentRecord[]> => {
  return await db.getActiveIncidentComments(incident_id);
};

/**
 * Get affected monitors by incident ID
 */
export const GetAffectedMonitorsByIncidentId = async (
  incident_id: number,
): Promise<Array<IncidentMonitorDetailRecord>> => {
  return await db.getMonitorsByIncidentId(incident_id);
};

// ============ Page Dashboard Data ============

export interface PageNavItem {
  page_title: string;
  page_path: string;
  page_header: string;
  page_logo: string | null;
  /**
   * G4. The page's primary custom domain, when it has one.
   *
   * The switcher links to it absolutely rather than to a path on the current
   * host, which is G3's deferred constraint: once a page lives on its own
   * domain, a relative link from a sibling page's domain would 404 or, worse,
   * silently serve the wrong page. Null means "same host, use the path".
   */
  primary_hostname?: string | null;
}

export interface PageDashboardData {
  pageStatus: PageStatus;
  ongoingIncidents: IncidentForMonitorListWithComments[];
  ongoingMaintenances: MaintenanceEventsMonitorList[];
  upcomingMaintenances: MaintenanceEventsMonitorList[];
  monitorTags: string[];
  monitorGroupMembersByTag: Record<string, string[]>;
  /**
   * G2: each monitor's `category_name`, keyed by the same tag as `monitorTags`.
   *
   * Keyed on the *physical* tag on purpose: `monitorTags` comes from
   * `pages_monitors.monitor_tag` and `GetMonitorsParsed` leaves `monitor.tag`
   * physical, so the two agree. Keying it on the per-org slug instead would
   * silently miss every lookup on a prefixed org and drop every monitor into the
   * uncategorised section, which looks like a rendering choice rather than a bug.
   *
   * A tag with no entry here is uncategorised - which covers both a genuinely
   * null `category_name` and a monitor on the page that `GetMonitorsParsed` did
   * not return.
   */
  monitorCategoriesByTag: Record<string, string | null>;
  /**
   * I3e: each monitor's per-org public slug, keyed by the same physical tag.
   *
   * Keyed on the tag for exactly the reason `monitorCategoriesByTag` is, and
   * carried *alongside* the tag rather than replacing it because the two mean
   * different things to the page. The bar fetches its data by tag, which is the
   * physical key the API and the cache speak; the link it wraps has to carry the
   * slug, because `monitor_tag` holds the org's prefix and a visitor should
   * never be shown another tenant's prefix.
   *
   * A tag with no entry falls back to itself, which is correct on the default
   * org - its prefix is empty, so slug and tag are the same string.
   */
  monitorSlugsByTag: Record<string, string>;
  pageDetails: PageRecordTyped;
  socialPagePreviewImage?: string;
  metaPageTitle?: string;
  metaPageDescription?: string;
}

// `BuildPageStatus` lived here and collapsed the latest sample of every monitor
// into one headline. It is gone: the same collapse now happens in
// `incidents/pageStatus.ts`, over each component's *derived* status rather than
// its raw sample, so an operator declaring a Partial Outage is reflected in the
// headline and in the API answer identically. See ADR 0007 for the collapse
// itself, which is unchanged.

export const BuildNotificationPayload = (
  ongoingIncidents: IncidentForMonitorListWithComments[],
  ongoingMaintenances: MaintenanceEventsMonitorList[],
  pastResolvedIncidents: IncidentForMonitorListWithComments[],
  upcomingMaintenances: MaintenanceEventsMonitorList[],
  pastMaintenances: MaintenanceEventsMonitorList[],
  nowTs: number,
): NotificationPayload => {
  const notifications: Array<NotificationEvent & { sortTs: number }> = [];

  for (const incident of ongoingIncidents) {
    const ts = incident.start_date_time;
    notifications.push({
      sortTs: ts,
      eventURL: `/incidents/${incident.id}`,
      eventTitle: incident.title,
      eventDate: new Date(ts * 1000).toISOString(),
      eventType: "incident",
      eventStartDateTime: incident.start_date_time,
      eventEndDateTime: incident.end_date_time,
      eventStatus: incident.state,
    });
  }

  for (const incident of pastResolvedIncidents) {
    const ts = incident.end_date_time ?? incident.start_date_time;
    notifications.push({
      sortTs: ts,
      eventURL: `/incidents/${incident.id}`,
      eventTitle: incident.title,
      eventDate: new Date(ts * 1000).toISOString(),
      eventType: "incident",
      eventStartDateTime: incident.start_date_time,
      eventEndDateTime: incident.end_date_time,
      eventStatus: incident.state,
    });
  }

  for (const maintenance of ongoingMaintenances) {
    const ts = maintenance.start_date_time;
    notifications.push({
      sortTs: ts,
      eventURL: `/maintenances/${maintenance.id}`,
      eventTitle: maintenance.title,
      eventDate: new Date(ts * 1000).toISOString(),
      eventType: "maintenance",
      eventStartDateTime: maintenance.start_date_time,
      eventEndDateTime: maintenance.end_date_time,
      eventStatus: GC.ONGOING,
    });
  }

  for (const maintenance of upcomingMaintenances) {
    const ts = maintenance.start_date_time;
    notifications.push({
      sortTs: ts,
      eventURL: `/maintenances/${maintenance.id}`,
      eventTitle: maintenance.title,
      eventDate: new Date(ts * 1000).toISOString(),
      eventType: "maintenance",
      eventStartDateTime: maintenance.start_date_time,
      eventEndDateTime: maintenance.end_date_time,
      eventStatus: GC.SCHEDULED,
    });
  }

  for (const maintenance of pastMaintenances) {
    const ts = maintenance.end_date_time;
    notifications.push({
      sortTs: ts,
      eventURL: `/maintenances/${maintenance.id}`,
      eventTitle: maintenance.title,
      eventDate: new Date(ts * 1000).toISOString(),
      eventType: "maintenance",
      eventStartDateTime: maintenance.start_date_time,
      eventEndDateTime: maintenance.end_date_time,
      eventStatus: GC.COMPLETED,
    });
  }

  return {
    notifications: notifications.sort((a, b) => a.sortTs - b.sortTs).map(({ sortTs, ...item }) => item),
  };
};

/**
 * Get all dashboard data for a status page
 * @param pagePath - The URL path of the page (e.g., "/" or "/api")
 * @returns Dashboard data or null if page not found
 */
export const GetPageDashboardData = async (
  pagePath: string,
  layoutData: LayoutServerData,
): Promise<PageDashboardData | null> => {
  // Fetch page by path with monitors
  const pageData = await GetPageByPathWithMonitors(pagePath);
  if (!pageData) {
    return null;
  }

  const { page: pageDetails, monitors: pageMonitors } = pageData;
  const monitorTags = pageMonitors.map((pm) => pm.monitor_tag);

  // Parse page settings with defaults
  let settings: PageSettingsType = mergePageSettings(null);
  if (pageDetails.page_settings_json) {
    try {
      const parsed =
        typeof pageDetails.page_settings_json === "string"
          ? JSON.parse(pageDetails.page_settings_json)
          : pageDetails.page_settings_json;
      settings = mergePageSettings(parsed);
    } catch {
      settings = mergePageSettings(null);
    }
  }
  const nowTs = GetMinuteStartNowTimestampUTC();

  // Convert to PageRecordTyped with parsed settings
  const pageDetailsTyped: PageRecordTyped = {
    id: pageDetails.id,
    page_path: pageDetails.page_path,
    page_title: pageDetails.page_title,
    page_header: pageDetails.page_header,
    page_subheader: pageDetails.page_subheader,
    page_logo: pageDetails.page_logo,
    page_settings: settings,
    created_at: pageDetails.created_at,
    updated_at: pageDetails.updated_at,
  };

  let socialPagePreviewImage: string | undefined = layoutData.socialPreviewImage;
  let metaPageTitle: string | undefined = layoutData.metaSiteTitle;
  let metaPageDescription: string | undefined = layoutData.metaSiteDescription;
  if (!!pageDetails.page_settings_json) {
    try {
      const pageSettings = JSON.parse(pageDetails.page_settings_json);
      if (pageSettings) {
        socialPagePreviewImage = pageSettings.socialPagePreviewImage || layoutData.socialPreviewImage;
        metaPageTitle = pageSettings.metaPageTitle || layoutData.metaSiteTitle;
        metaPageDescription = pageSettings.metaPageDescription || layoutData.metaSiteDescription;
      }
    } catch (e) {
      // Ignore JSON parsing errors and fallback to layout data or defaults
    }
  }

  if (monitorTags.length === 0) {
    return {
      pageStatus: await getPageStatus([], nowTs),
      ongoingIncidents: [],
      ongoingMaintenances: [],
      upcomingMaintenances: [],
      monitorTags,
      monitorGroupMembersByTag: {},
      monitorCategoriesByTag: {},
      monitorSlugsByTag: {},
      pageDetails: pageDetailsTyped,
      socialPagePreviewImage,
      metaPageTitle,
      metaPageDescription,
    };
  }
  const eventSettings = layoutData.eventDisplaySettings;
  const showInlineEvents = eventSettings.showInlineEvents === true;
  // Fetch all dashboard data in parallel (respecting feature toggles)
  const [latestData, parsedMonitors, ongoingIncidents, ongoingMaintenances, upcomingMaintenances] = await Promise.all([
    GetLatestMonitoringDataAllActive(monitorTags),
    GetMonitorsParsed({ tags: monitorTags, status: "ACTIVE", is_hidden: "NO" }),
    showInlineEvents && eventSettings.incidents.enabled && eventSettings.incidents.ongoing.show
      ? GetOngoingIncidentsForMonitorList(monitorTags)
      : Promise.resolve([] as IncidentForMonitorListWithComments[]),
    showInlineEvents && eventSettings.maintenances.enabled && eventSettings.maintenances.ongoing.show
      ? GetOngoingMaintenances(monitorTags, nowTs)
      : Promise.resolve([] as MaintenanceEventsMonitorList[]),
    showInlineEvents && eventSettings.maintenances.enabled && eventSettings.maintenances.upcoming.show
      ? GetUpcomingMaintenanceEventsForMonitorList(
          monitorTags,
          eventSettings.maintenances.upcoming.maxCount,
          eventSettings.maintenances.upcoming.daysInFuture,
        )
      : Promise.resolve([] as MaintenanceEventsMonitorList[]),
  ]);

  // Derived server-side over the components, not collapsed from raw samples
  // (C2b). The value the page prints, the value the API returns and the value a
  // `page.status_changed` webhook carries are now the same computation, which is
  // what makes them capable of agreeing.
  const pageStatus = await getPageStatus(monitorTags, nowTs, latestData as LatestStatus[]);
  const monitorGroupMembersByTag: Record<string, string[]> = {};
  // G2. Trimmed and emptied to null here rather than in the component, so
  // "   " and "" and null are one case by the time anything renders them.
  const monitorCategoriesByTag: Record<string, string | null> = {};
  // I3e. `|| tag` rather than `?? tag`: a slug that is present but empty is as
  // unusable in a URL as one that is missing.
  const monitorSlugsByTag: Record<string, string> = {};
  for (const monitor of parsedMonitors) {
    const category = (monitor.category_name ?? "").trim();
    monitorCategoriesByTag[monitor.tag] = category.length > 0 ? category : null;
    monitorSlugsByTag[monitor.tag] = monitor.slug || monitor.tag;
  }

  for (const monitor of parsedMonitors) {
    if (monitor.monitor_type !== "GROUP") continue;

    const groupData = monitor.type_data as GroupMonitorTypeData;
    if (!groupData?.monitors || !Array.isArray(groupData.monitors)) continue;

    monitorGroupMembersByTag[monitor.tag] = groupData.monitors.map((member) => member.tag);
  }

  return {
    pageStatus,
    ongoingIncidents,
    ongoingMaintenances,
    upcomingMaintenances,
    monitorTags,
    monitorGroupMembersByTag,
    monitorCategoriesByTag,
    monitorSlugsByTag,
    pageDetails: pageDetailsTyped,
    socialPagePreviewImage,
    metaPageTitle,
    metaPageDescription,
  };
};
