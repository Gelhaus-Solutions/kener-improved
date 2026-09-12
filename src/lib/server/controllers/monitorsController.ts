import { ResolvePublicMonitorTag } from "./publicMonitorResolver.js";
import {
  GetMinuteStartNowTimestampUTC,
  GetMinuteStartTimestampUTC,
  GetNowTimestampUTC,
  GetNowTimestampUTCInMs,
  UnparsePercentage,
  UptimeCalculator,
} from "../tool.js";
import { getCache, setCache } from "../cache/cache.js";
import { getUptimeBucketsCached } from "../cache/rollupCache.js";
import { pickGrain, rollupsUsable } from "../services/uptimeAggregator.js";
import { slugFromTag } from "../db/monitorSlug.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import { currentOrgIdOrDefault } from "../db/orgContext.js";
import type {
  MonitorRecordInsert,
  MonitorAlertInsert,
  MonitorRecordTyped,
  MonitorRecord,
  MonitorAlert,
  MonitoringData,
  TimestampStatusCount,
  UptimeCalculatorResult,
  TimestampStatusCountByMonitor,
} from "../types/db.js";
import type { MonitorFilter } from "../db/repositories/base.js";
import db from "../db/db.js";
import type { PaginationInput } from "../../types/common.js";
import GC, { getBadgeStyle, isMonitoringStatus, MONITORING_STATUSES, type BadgeStyle } from "../../global-constants.js";
import type { MonitoringStatus } from "../../types/status.js";
import { makeBadge } from "badge-maker";
import { ErrorSvg } from "../../anywhere.js";
import { GetLastMonitoringValue, SetLastHeartbeat, DeleteMonitorCaches } from "../cache/setGet.js";
import { CollapseStatusCounts } from "../../clientTools.js";
import { translate, isLocaleAvailable } from "../i18n.js";
import type { HeartbeatMonitor, GroupMonitorTypeData } from "../types/monitor.js";
import { IsValidProxyURL } from "../../anywhere.js";
import { reconcileProbeAssignments } from "../probes/reconcile.js";

interface GroupUpdateData {
  monitor_tag: string;
  timestamp: number;
  status: string;
  latency: number;
}

interface MonitorInput extends MonitorRecordInsert {
  id?: number;
}

/**
 * Validates that a monitor tag is URL-friendly: lowercase alphanumeric, hyphens, and underscores only.
 * Must start and end with an alphanumeric character.
 */
const VALID_TAG_REGEX = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/;
const VALID_TAG_SINGLE_CHAR_REGEX = /^[a-z0-9]$/;

function isValidMonitorTag(tag: string): boolean {
  if (!tag || tag.length === 0) return false;
  if (tag.length === 1) return VALID_TAG_SINGLE_CHAR_REGEX.test(tag);
  return VALID_TAG_REGEX.test(tag);
}

function validateMonitorTag(tag: string): void {
  const trimmed = tag?.trim();
  if (!trimmed) {
    throw new Error("Monitor tag is required");
  }
  if (!isValidMonitorTag(trimmed)) {
    throw new Error(
      "Monitor tag must be URL-friendly: only lowercase letters, numbers, hyphens, and underscores. Must start and end with a letter or number.",
    );
  }
}

interface DayGroupData {
  timestamp: number;
  total: number;
  UP: number;
  DOWN: number;
  DEGRADED: number;
  MAINTENANCE: number;
  NO_DATA: number;
  [key: string]: number;
}

interface UpdateMonitoringDataInput {
  monitor_tag: string;
  start: number;
  end: number;
  newStatus: string;
  type: string;
  latency?: number;
  deviation?: number;
}
interface MonitoringDataInput {
  monitor_tag: string;
  timestamp: number;
  status: string;
  latency?: number;
  type: string;
  error_message?: string | null;
  raw_status?: string | null;
  /**
   * Which region observed this sample (B1b). Absent means the merged verdict at
   * region 0, which is every sample a local check produces and therefore every
   * sample that existed before remote probes.
   */
  region_id?: number;
}

interface InterpolatedDataEntry {
  timestamp: number;
  status: string;
}

export const InsertMonitoringData = async (data: MonitoringDataInput): Promise<MonitoringData | null> => {
  //do validation if present all fields below
  if (!data.monitor_tag || !data.timestamp || !data.status || !data.type) {
    throw new Error("Invalid data");
  }

  return await db.insertMonitoringData({
    monitor_tag: data.monitor_tag,
    timestamp: data.timestamp,
    // Passed through rather than defaulted here: the repository already defaults
    // an absent region to the merged verdict, and defaulting it twice is two
    // places to change when that ever stops being the right default.
    region_id: data.region_id,
    status: data.status,
    latency: data.latency || 0,
    type: data.type,
    error_message: data.error_message,
    raw_status: data.raw_status,
  });
};

/**
 * The longest window one manual rewrite may cover.
 *
 * Ninety days, the same number and the same reasoning as C7's
 * `MAX_BACKFILL_WINDOW_SECONDS`: at one row per minute that is ~130k rows for a
 * single monitor, which is already more than anyone should write in one call,
 * and a window this long almost always means somebody typed the wrong year
 * rather than that a service was down for a quarter.
 */
export const MAX_MANUAL_UPDATE_WINDOW_SECONDS = 90 * 24 * 60 * 60;

/**
 * Rewrites a monitor's history over a window.
 *
 * **Everything below is validation this function used to do none of, and the
 * gap was not theoretical.** It read `newStatus` and passed it straight to the
 * database, so a caller who sent `status` instead - a reasonable guess, since
 * every other monitoring-data shape in this codebase calls the column `status` -
 * wrote one row per minute of the window with a **null status**, over real
 * history, and got a 200 back. An hour of it is 61 destroyed rows.
 *
 * The checks live here rather than in the action, because there are two callers
 * and only one of them was ever right. `/api/v4/monitors/<tag>/data` validates
 * its own body thoroughly and would never reach these throws; the manage action
 * `updateMonitoringData` passes the payload through untouched and is the path
 * the hole was found on. One chokepoint covers both, and the API keeps its own
 * checks so its error messages stay in its own shape.
 *
 * The status set is `UP`, `DOWN`, `DEGRADED`: exactly what the v4 endpoint
 * accepts and exactly what `ModifyDataCard` offers. `MAINTENANCE` and `NO_DATA`
 * are deliberately not writable here - a maintenance overlay is written by the
 * maintenance system, and writing NO_DATA over real samples is a delete wearing
 * a write's clothes, which is precisely the corruption this guard exists to
 * stop.
 */
/** A validated, minute-floored manual update. What `db.updateMonitoringData` is given. */
export interface NormalisedMonitoringDataUpdate {
  monitor_tag: string;
  start: number;
  end: number;
  newStatus: string;
  latency: number;
  deviation: number;
}

/**
 * Validates and normalises a manual history rewrite, or throws saying why.
 *
 * Separate from `UpdateMonitoringData` so the manage action can run it as its
 * `schema` and turn a rejection into a 400. Called from inside
 * `UpdateMonitoringData` as well, so a caller that skips the action still cannot
 * write a malformed row: the check is the chokepoint, and the action only
 * decides what status code a rejection wears.
 */
export function normaliseMonitoringDataUpdate(data: UpdateMonitoringDataInput): NormalisedMonitoringDataUpdate {
  const queryData = { ...data };

  if (!queryData.monitor_tag || typeof queryData.monitor_tag !== "string") {
    throw new Error("monitor_tag is required");
  }

  if (!Number.isFinite(queryData.start) || !Number.isFinite(queryData.end)) {
    throw new Error("start and end are required and must be UTC timestamps in seconds");
  }

  const start = GetMinuteStartTimestampUTC(queryData.start);
  const end = GetMinuteStartTimestampUTC(queryData.end);

  // `end < start`, not `end <= start`. Both bounds are floored to a minute and
  // the write is inclusive of the end, so an equal pair is a legitimate
  // single-minute correction - which is what `ModifyDataCard` sends when
  // somebody picks one minute, and refusing it would break the screen this fix
  // is not allowed to break.
  if (end < start) {
    throw new Error("end must not be before start");
  }

  if (end - start > MAX_MANUAL_UPDATE_WINDOW_SECONDS) {
    const days = Math.round((end - start) / 86400);
    throw new Error(
      `A manual update may cover at most ${MAX_MANUAL_UPDATE_WINDOW_SECONDS / 86400} days; this one covers ${days}`,
    );
  }

  if (!isMonitoringStatus(queryData.newStatus)) {
    throw new Error(`newStatus is required and must be one of: ${MONITORING_STATUSES.join(", ")}`);
  }

  const latency = queryData.latency ?? 0;
  const deviation = queryData.deviation ?? 0;
  if (!Number.isFinite(latency) || latency < 0) {
    throw new Error("latency must be a non-negative number");
  }
  if (!Number.isFinite(deviation) || deviation < 0) {
    throw new Error("deviation must be a non-negative number");
  }

  return { monitor_tag: queryData.monitor_tag, start, end, newStatus: queryData.newStatus, latency, deviation };
}

export const UpdateMonitoringData = async (data: UpdateMonitoringDataInput): Promise<unknown[]> => {
  const valid = normaliseMonitoringDataUpdate(data);

  return await db.updateMonitoringData(
    valid.monitor_tag,
    valid.start,
    valid.end,
    valid.newStatus,
    data.type,
    valid.latency,
    valid.deviation,
  );
};

export const AggregateData = (
  rawData: InterpolatedDataEntry[],
): { total: number; UPs: number; DOWNs: number; DEGRADEDs: number; NO_DATAs: number } => {
  //data like [{ timestamp: 1732435920, status: 'NO_DATA' }]
  let rawDataWithStatus = rawData.filter((data) => data.status !== GC.NO_DATA);
  const total = rawDataWithStatus.length;
  const UPs = rawDataWithStatus.filter((data) => data.status === GC.UP).length;
  const DOWNs = rawDataWithStatus.filter((data) => data.status === GC.DOWN).length;
  const DEGRADEDs = rawDataWithStatus.filter((data) => data.status === GC.DEGRADED).length;
  const NO_DATAs = total - (UPs + DOWNs + DEGRADEDs);

  return { total, UPs, DOWNs, DEGRADEDs, NO_DATAs };
};

export const GetMonitorsParsed = async (query: MonitorFilter): Promise<Array<MonitorRecordTyped>> => {
  // Retrieve monitors from the database based on the provided query
  const rawMonitors = await db.getMonitors(query);

  // Parse type_data if available for each monitor
  const parsedMonitors = rawMonitors.map((monitor) => {
    const monitorData: MonitorRecord = { ...monitor };
    const monitorTyped: MonitorRecordTyped = {
      ...monitorData,
      type_data: {},
      monitor_settings_json: {},
    };

    if (monitorData.type_data) {
      try {
        monitorTyped.type_data = JSON.parse(monitorData.type_data);
      } catch (error) {
        // Fallback to an empty object if JSON parsing fails
        monitorTyped.type_data = {};
      }
    } else {
      monitorTyped.type_data = {};
    }

    if (monitorData.monitor_settings_json) {
      try {
        monitorTyped.monitor_settings_json = JSON.parse(monitorData.monitor_settings_json);
      } catch (error) {
        // Fallback to default settings if JSON parsing fails
        monitorTyped.monitor_settings_json = {
          uptime_formula_numerator: GC.defaultNumeratorStr,
          uptime_formula_denominator: GC.defaultDenominatorStr,
        };
      }
    } else {
      monitorTyped.monitor_settings_json = {
        uptime_formula_numerator: GC.defaultNumeratorStr,
        uptime_formula_denominator: GC.defaultDenominatorStr,
      };
    }

    return monitorTyped;
  });

  return parsedMonitors;
};

/**
 * type_data.proxy must be a valid http(s):// URL. Node silently ignores any other scheme and
 * throws on a malformed authority, both at check time, so save is where a typo has to fail.
 * `$SECRET` tokens are still raw here and pass. Unparseable type_data is not this check's problem.
 */
function validateTypeDataProxy(monitor: MonitorInput): void {
  if (!monitor.type_data) return;
  let typeData: unknown;
  try {
    typeData = typeof monitor.type_data === "string" ? JSON.parse(monitor.type_data) : monitor.type_data;
  } catch {
    return;
  }
  // type_data is parsed JSON, so `proxy` can be any type. Absent or blank means no proxy;
  // anything else - an object or a number included - has to be a proxy URL.
  const proxy = (typeData as { proxy?: unknown } | null)?.proxy;
  if (proxy === undefined || proxy === null) return;
  if (typeof proxy === "string" && proxy.trim() === "") return;
  if (!IsValidProxyURL(proxy)) {
    throw new Error("Proxy URL must be a valid http:// or https:// URL");
  }
}

export const CreateUpdateMonitor = async (monitor: MonitorInput): Promise<number | number[]> => {
  let monitorData = { ...monitor };
  validateTypeDataProxy(monitorData);
  if (monitorData.id) {
    return await db.updateMonitor(monitorData as MonitorRecord);
  } else {
    validateMonitorTag(monitorData.tag);
    // I3e: this is the path the admin screen uses, so it is the one that had been
    // creating monitors with a null slug ever since the column was added.
    if (!monitorData.slug) monitorData.slug = await slugForTag(monitorData.tag);
    const created = await db.insertMonitor(monitorData);
    // B1e: a region whose rule is "check everything" means this one too, and an
    // operator should not have to wait a minute for the scheduler's sweep to
    // agree with what the probes screen already shows.
    await reconcileAfterMonitorChange(monitorData.tag);
    return created;
  }
};

/**
 * Re-resolves the probe assignments after a monitor appears.
 *
 * Failure is logged and swallowed on purpose: a monitor that was created is
 * created, and refusing the whole operation because the probe fleet could not be
 * re-resolved would be the wrong trade. `appScheduler` reconciles on its sweep,
 * so the worst case is that the region picks the monitor up a minute later.
 */
async function reconcileAfterMonitorChange(tag: string | undefined): Promise<void> {
  try {
    await reconcileProbeAssignments();
  } catch (error) {
    console.error(`Probe assignment reconcile failed after creating ${tag}:`, error);
  }
}

/**
 * The per-org slug for a tag (I3e).
 *
 * `tag` is globally unique and carries the org's prefix; `slug` is the per-org
 * name the public URL is built from. On the default org the prefix is empty and
 * the two are identical, which is exactly why forgetting this stayed invisible:
 * nothing goes wrong until a second org exists.
 */
async function slugForTag(tag: string): Promise<string> {
  try {
    const org = await db.getOrgById(currentOrgIdOrDefault());
    return slugFromTag(tag, org?.tag_prefix);
  } catch {
    // No org context, or the org row is unreadable. The tag is always a legal
    // slug, and a monitor with a usable-but-prefixed slug is far better than one
    // with a null slug and no public page at all.
    return tag;
  }
}

export const CreateMonitor = async (monitor: MonitorInput): Promise<number[]> => {
  let monitorData = { ...monitor };
  if (monitorData.id) {
    throw new Error("monitor id must be empty or 0");
  }
  validateMonitorTag(monitorData.tag);
  validateTypeDataProxy(monitorData);
  // I3e: set explicitly rather than left to the repository's fallback, which
  // cannot know the org prefix.
  if (!monitorData.slug) monitorData.slug = await slugForTag(monitorData.tag);
  const created = await db.insertMonitor(monitorData);
  await reconcileAfterMonitorChange(monitorData.tag);
  return created;
};

interface CloneMonitorInput {
  sourceTag: string;
  newTag: string;
  newName: string;
}

export const CloneMonitor = async ({ sourceTag, newTag, newName }: CloneMonitorInput): Promise<number[]> => {
  const sourceTagTrimmed = sourceTag?.trim();
  const newTagTrimmed = newTag?.trim();
  const newNameTrimmed = newName?.trim();

  if (!sourceTagTrimmed) {
    throw new Error("Source monitor tag is required");
  }
  if (!newTagTrimmed) {
    throw new Error("Tag is required");
  }
  validateMonitorTag(newTagTrimmed);
  if (!newNameTrimmed) {
    throw new Error("Name is required");
  }
  if (sourceTagTrimmed === newTagTrimmed) {
    throw new Error("New tag must be different from source tag");
  }

  const source = await db.getMonitorsByTag(sourceTagTrimmed);
  if (!source) {
    throw new Error("Source monitor not found");
  }

  const existingTag = await db.getMonitorsByTag(newTagTrimmed);
  if (existingTag) {
    throw new Error("Monitor tag already exists");
  }

  const allMonitors = await db.getMonitors({});
  if (allMonitors.some((m) => m.name === newNameTrimmed)) {
    throw new Error("Monitor name already exists");
  }

  const inserted = await db.insertMonitor({
    tag: newTagTrimmed,
    slug: await slugForTag(newTagTrimmed),
    name: newNameTrimmed,
    description: source.description,
    image: source.image,
    cron: source.cron,
    default_status: source.default_status,
    status: source.status,
    category_name: source.category_name,
    monitor_type: source.monitor_type,
    down_trigger: source.down_trigger,
    degraded_trigger: source.degraded_trigger,
    type_data: source.type_data,
    day_degraded_minimum_count: source.day_degraded_minimum_count,
    day_down_minimum_count: source.day_down_minimum_count,
    confirmation_threshold: source.confirmation_threshold,
    include_degraded_in_downtime: source.include_degraded_in_downtime,
    is_hidden: source.is_hidden,
    monitor_settings_json: source.monitor_settings_json,
    external_url: source.external_url,
  });

  await cloneMonitorRelations(sourceTagTrimmed, newTagTrimmed);
  await reconcileAfterMonitorChange(newTagTrimmed);

  return inserted;
};

/**
 * Copies the side tables a monitor owns onto its clone.
 *
 * **A monitor is not just its row.** Before this, cloning produced a monitor
 * that was on no status page, had no dependencies, and no rollup settings - so
 * it was invisible to the public, sat outside the component graph, and had to be
 * rebuilt by hand. "Clone" that copies a third of the thing is worse than no
 * clone, because the gaps are silent.
 *
 * **What is deliberately not copied**, and why:
 *
 *   `monitor_alerts_config_monitors`  attaching a clone to live alert rules means
 *                                     creating one can start paging people. That
 *                                     is the only relation here with an outward
 *                                     side effect, and it needs to be a decision
 *                                     rather than a side effect of a button.
 *   `monitoring_data`                 the clone has no history; it never ran.
 *   `incident_monitors`,              somebody else's past, not this monitor's
 *   `maintenance_monitors`            configuration.
 *   `subscriber_subscriptions`        customers chose those, per component. A
 *                                     clone inheriting them would sign people up
 *                                     for something they never asked for.
 *
 * Best-effort per relation. A clone whose row exists but whose page membership
 * failed is recoverable by hand; a clone that throws half way leaves a monitor
 * the caller was told was not created, which is worse.
 */
async function cloneMonitorRelations(sourceTag: string, newTag: string): Promise<void> {
  // ---- page membership ---------------------------------------------------
  try {
    for (const row of await db.getPagesByMonitorTag(sourceTag)) {
      // Appended rather than sharing the source's position, which would put two
      // monitors at the same index and leave the order to whatever the sort
      // happens to do. Computed per page because each has its own sequence.
      const existing = await db.getPageMonitors(row.page_id);
      const nextPosition = existing.reduce((max, m) => Math.max(max, Number(m.position ?? 0)), -1) + 1;
      await db.addMonitorToPage({
        page_id: row.page_id,
        monitor_tag: newTag,
        monitor_settings_json: row.monitor_settings_json ?? "",
        position: nextPosition,
      });
    }
  } catch (error) {
    console.error(`clone ${sourceTag} -> ${newTag}: page membership failed`, error);
  }

  // ---- dependency edges, both directions ---------------------------------
  //
  // Both, because a like-for-like copy sits in the graph the same way: it depends
  // on what the original depends on, and it is part of whatever the original is
  // part of. An edge between the source and itself would be meaningless, so a
  // self-referential edge is remapped to the clone rather than pointing back.
  try {
    const { children, parents } = await db.getDependenciesForMonitor(sourceTag);
    const remap = (tag: string) => (tag === sourceTag ? newTag : tag);
    for (const edge of children) {
      await db.insertDependency({
        parent_monitor_tag: newTag,
        child_monitor_tag: remap(edge.child_monitor_tag),
        relation: edge.relation,
        propagation: edge.propagation,
        weight: edge.weight,
      });
    }
    for (const edge of parents) {
      await db.insertDependency({
        parent_monitor_tag: remap(edge.parent_monitor_tag),
        child_monitor_tag: newTag,
        relation: edge.relation,
        propagation: edge.propagation,
        weight: edge.weight,
      });
    }
  } catch (error) {
    console.error(`clone ${sourceTag} -> ${newTag}: dependencies failed`, error);
  }

  // ---- rollup settings ---------------------------------------------------
  //
  // Only when the source has a row: absence is meaningful (it means "defaults"),
  // and writing one for the clone would make it configured where the original is
  // not.
  //
  // **The manual pin is deliberately not carried over.** It says "this component
  // is X right now whatever rolls up", which is a statement about an incident in
  // progress on the original. A brand-new monitor that has never run must not
  // start life pinned to a status somebody set for something else.
  try {
    const setting = await db.getRollupSetting(sourceTag);
    if (setting) {
      await db.upsertRollupSetting({
        monitor_tag: newTag,
        rollup_mode: setting.rollup_mode,
        manual_override: null,
        manual_override_reason: null,
        manual_override_expires_at: null,
        show_dependencies: setting.show_dependencies,
      });
    }
  } catch (error) {
    console.error(`clone ${sourceTag} -> ${newTag}: rollup settings failed`, error);
  }
}

export const UpdateMonitor = async (monitor: MonitorInput): Promise<number> => {
  let monitorData = { ...monitor };
  if (!!!monitorData.id || monitorData.id === 0) {
    throw new Error("monitor id cannot be empty or 0");
  }
  return await db.updateMonitor(monitorData as MonitorRecord);
};

export const GetMonitors = async (data: MonitorFilter): Promise<MonitorRecord[]> => {
  return await db.getMonitors(data);
};

export const GetLatestMonitoringData = async (monitor_tag: string): Promise<MonitoringData | undefined> => {
  let latestData = await db.getLatestMonitoringData(monitor_tag);

  return latestData;
};
export const GetLatestStatusActiveAll = async (): Promise<{ status: string }> => {
  //get all the active not hidden monitor tags
  const monitors = await db.getMonitors({ status: GC.ACTIVE, is_hidden: GC.NO });
  const monitor_tags = monitors.map((m) => m.tag);

  const latestData: MonitoringData[] = [];
  for (let i = 0; i < monitor_tags.length; i++) {
    const tag = monitor_tags[i];
    const lastObj = await GetLastMonitoringValue(tag, () => GetLatestMonitoringData(tag));
    if (lastObj) {
      latestData.push(lastObj);
    }
  }

  const counts = { countOfUp: 0, countOfDown: 0, countOfDegraded: 0, countOfMaintenance: 0 };
  for (const data of latestData) {
    if (data.status === GC.UP) {
      counts.countOfUp++;
    } else if (data.status === GC.DOWN) {
      counts.countOfDown++;
    } else if (data.status === GC.DEGRADED) {
      counts.countOfDegraded++;
    } else if (data.status === GC.MAINTENANCE) {
      counts.countOfMaintenance++;
    }
  }
  return {
    status: CollapseStatusCounts(counts),
  };
};

//getLatestMonitoringDataAllActive
export const GetLatestMonitoringDataAllActive = async (monitor_tags: string[]): Promise<MonitoringData[]> => {
  let latestData = await db.getLatestMonitoringDataAllActive(monitor_tags);
  return latestData;
};

export const GetLastHeartbeat = async (monitor_tag: string): Promise<MonitoringData | undefined> => {
  return await db.getLastHeartbeat(monitor_tag);
};

export const RegisterHeartbeat = async (nameInUrl: string, secret: string): Promise<string> => {
  // I3e: a heartbeat URL carries the per-org slug like every other public URL.
  // These live in external cron jobs and uptime pingers for years, so the
  // default org resolving slug to the identical tag is what keeps them working.
  const tag = (await ResolvePublicMonitorTag(nameInUrl)) ?? nameInUrl;
  let monitor = (await GetMonitorsParsed({ tag, status: "ACTIVE", monitor_type: "HEARTBEAT" }).then((monitors) =>
    monitors.length > 0 ? monitors[0] : null,
  )) as HeartbeatMonitor | null;
  if (!monitor) {
    throw new Error("Monitor not found");
  }

  let typeData = monitor.type_data;
  if (!typeData) {
    throw new Error("Monitor type data not found");
  }
  try {
    let heartbeatConfig = typeData;
    let heartbeatSecret = heartbeatConfig.secretString;
    if (heartbeatSecret === secret) {
      // Store last heartbeat in seconds (DB uses seconds). Heartbeat evaluator tolerates older ms values.
      let nowSec = GetNowTimestampUTC();

      // Avoid rare collisions with minute-rounded monitoring timestamps (which can overwrite due to PK constraints).
      // Minute-rounded timestamps always end with :00 seconds.
      if (nowSec % 60 === 0) {
        nowSec += 1;
      }

      await SetLastHeartbeat(tag, nowSec);

      // Best-effort persist a heartbeat SIGNAL for restart recovery.
      // Failure here should not break heartbeat reception.
      try {
        await InsertMonitoringData({
          monitor_tag: tag,
          timestamp: nowSec,
          status: GC.UP,
          latency: 0,
          type: GC.SIGNAL,
          error_message: null,
        });
      } catch (e) {
        console.error("Error persisting heartbeat signal:", e);
      }
      return "OK";
    }
  } catch (e) {
    console.error("Error registering heartbeat:", e);
  }
  throw new Error("Invalid heartbeat secret");
};

/**
 * Removes a monitor tag from all GROUP monitors that reference it,
 * rebalances weights equally, and deactivates groups left with < 2 members.
 */
async function removeTagFromGroupMonitors(tag: string): Promise<void> {
  const groupMonitors = await GetMonitorsParsed({ monitor_type: "GROUP" });

  for (const group of groupMonitors) {
    const typeData = group.type_data as GroupMonitorTypeData;
    if (!typeData.monitors || !Array.isArray(typeData.monitors)) continue;

    const hasMember = typeData.monitors.some((m) => m.tag === tag);
    if (!hasMember) continue;

    // Remove the deleted tag
    const remaining = typeData.monitors.filter((m) => m.tag !== tag);

    // Rebalance weights equally across remaining monitors
    if (remaining.length > 0) {
      const weight = Math.round((1 / remaining.length) * 1000) / 1000;
      for (let i = 0; i < remaining.length; i++) {
        remaining[i].weight =
          i === remaining.length - 1 ? Math.round((1 - weight * (remaining.length - 1)) * 1000) / 1000 : weight;
      }
    }

    typeData.monitors = remaining;

    const updateData: Record<string, unknown> = {
      id: group.id,
      tag: group.tag,
      name: group.name,
      description: group.description,
      image: group.image,
      cron: group.cron,
      default_status: group.default_status,
      status: remaining.length < 2 ? "INACTIVE" : group.status,
      category_name: group.category_name,
      monitor_type: group.monitor_type,
      type_data: JSON.stringify(typeData),
      day_degraded_minimum_count: group.day_degraded_minimum_count,
      day_down_minimum_count: group.day_down_minimum_count,
      confirmation_threshold: group.confirmation_threshold,
      include_degraded_in_downtime: group.include_degraded_in_downtime,
      is_hidden: group.is_hidden,
      monitor_settings_json:
        typeof group.monitor_settings_json === "string"
          ? group.monitor_settings_json
          : JSON.stringify(group.monitor_settings_json),
      external_url: group.external_url,
    };

    await db.updateMonitor(updateData as unknown as MonitorRecord);
  }
}

export const DeleteMonitorCompletelyUsingTag = async (tag: string): Promise<number> => {
  await db.deleteMonitorDataByTag(tag);
  await db.deleteIncidentMonitorsByTag(tag);
  await db.deleteMonitorAlertsByTag(tag);
  await db.deleteMonitorAlertConfigsByMonitorTag(tag);
  await db.deletePageMonitorsByTag(tag);
  await db.deleteMaintenanceMonitorsByTag(tag);
  // Probes (B1c) and the merge cascade (B1d). Neither was being cleaned up:
  // `deleteProbeAssignmentsForMonitor` shipped with B1c and nothing ever called
  // it, so a deleted monitor left its assignment behind and the probes screen
  // listed a row pointing at a tag that no longer existed. Recreating a monitor
  // with the same tag would then silently inherit the dead monitor's probes.
  await db.deleteProbeAssignmentsForMonitor(tag);
  await db.deleteMergePoliciesForMonitor(tag);
  await removeTagFromGroupMonitors(tag);
  await DeleteMonitorCaches(tag);
  return await db.deleteMonitorsByTag(tag);
};

//getMonitorsByTag
export const GetMonitorsByTag = async (tag: string): Promise<MonitorRecord | undefined> => {
  return await db.getMonitorsByTag(tag);
};

export const GetAllAlertsPaginated = async (
  data: PaginationInput,
): Promise<{ alerts: MonitorAlert[]; total: number }> => {
  const countResult = await db.getMonitorAlertsCount();
  return {
    alerts: await db.getMonitorAlertsPaginated(data.page, data.limit),
    total: countResult ? Number(countResult.count) : 0,
  };
};

export const GetMonitoringData = async (tag: string, since: number, now: number): Promise<MonitoringData[]> => {
  return await db.getMonitoringData(tag, since, now);
};

export const InsertNewAlert = async (data: MonitorAlertInsert): Promise<MonitorAlert | undefined> => {
  if (await db.alertExists(data.monitor_tag, data.monitor_status, data.alert_status)) {
    return;
  }
  await db.insertAlert(data);
  return await db.getActiveAlert(data.monitor_tag, data.monitor_status, data.alert_status);
};

/**
 * Uptime buckets for a set of monitors (I9).
 *
 * **The single entry point for "how did these monitors do over this window".**
 * Both bar endpoints go through here, so the rollup path, its cache and the
 * fallback are decided once rather than in two places that could drift.
 *
 * Returns null when the rollups cannot serve the request: not backfilled yet
 * (the kill switch), an alignment no grain divides, or anything thrown on the
 * way. Every caller falls back to the raw query it has always used - a slow
 * correct answer beats a fast wrong one, and this is the only path a customer's
 * uptime percentage travels.
 */
const GetUptimeBucketsFromRollups = async (
  monitorTags: string[],
  start: number,
  interval: number,
  numIntervals: number,
): Promise<Map<string, TimestampStatusCount[]> | null> => {
  try {
    const grain = pickGrain(start, interval);
    if (!(await rollupsUsable(grain))) return null;
    const state = await db.getRollupState(grain, MERGED_REGION_ID);
    if (!state?.watermark_ts) return null;
    return await getUptimeBucketsCached(
      { monitorTags, startTimestamp: start, intervalSeconds: interval, points: numIntervals },
      state.watermark_ts,
    );
  } catch (error) {
    // Never let the fast path be the reason a status page fails to render.
    console.error("Rollup read path failed; falling back to raw aggregation:", error);
    return null;
  }
};

//getStatusCountsByInterval
export const GetStatusCountsByInterval = async (
  monitor_tag: string | string[],
  start: number,
  interval: number,
  numIntervals: number,
): Promise<TimestampStatusCount[]> => {
  const tags = Array.isArray(monitor_tag) ? monitor_tag : [monitor_tag];
  const fromRollups = await GetUptimeBucketsFromRollups(tags, start, interval, numIntervals);
  if (fromRollups) {
    // A multi-tag call asks for the *combined* series, which is what the raw SQL
    // returns: one row per timestamp across every tag. Merging here keeps that
    // contract rather than changing what an existing caller receives.
    if (tags.length === 1) return fromRollups.get(tags[0]) ?? [];
    return mergeSeriesAcrossMonitors(fromRollups);
  }
  return await db.getStatusCountsByInterval(monitor_tag, start, interval, numIntervals);
};

/**
 * Combines several monitors' series into one, timestamp by timestamp.
 *
 * Mirrors what `getStatusCountsByInterval` does in SQL for a tag array: it
 * groups by timestamp alone, so every monitor's counts for a bucket land in one
 * row. The latency figures are combined the same way `UptimeCalculator` would
 * read them - a count-weighted mean, and true extremes.
 */
function mergeSeriesAcrossMonitors(byTag: Map<string, TimestampStatusCount[]>): TimestampStatusCount[] {
  const byTs = new Map<number, TimestampStatusCount & { _latencyWeight: number }>();
  for (const series of byTag.values()) {
    for (const point of series) {
      const existing = byTs.get(point.ts);
      // The weight is the bucket's own sample count, not one per bucket: a
      // monitor with ten samples in a bucket and one with a thousand must not
      // contribute equally to the average.
      const weight = point.countOfUp + point.countOfDown + point.countOfDegraded + point.countOfMaintenance;
      if (!existing) {
        byTs.set(point.ts, { ...point, _latencyWeight: point.avgLatency > 0 ? weight : 0 });
        continue;
      }
      existing.countOfUp += point.countOfUp;
      existing.countOfDown += point.countOfDown;
      existing.countOfDegraded += point.countOfDegraded;
      existing.countOfMaintenance += point.countOfMaintenance;
      if (point.avgLatency > 0) {
        const totalWeight = existing._latencyWeight + weight;
        existing.avgLatency =
          totalWeight > 0
            ? (existing.avgLatency * existing._latencyWeight + point.avgLatency * weight) / totalWeight
            : 0;
        existing._latencyWeight = totalWeight;
      }
      if (point.maxLatency > existing.maxLatency) existing.maxLatency = point.maxLatency;
      if (existing.minLatency === 0 || (point.minLatency > 0 && point.minLatency < existing.minLatency)) {
        existing.minLatency = point.minLatency;
      }
    }
  }
  return [...byTs.values()]
    .sort((a, b) => a.ts - b.ts)
    .map(({ _latencyWeight, ...point }) => point as TimestampStatusCount);
}

//getMonitoringDataPaginated
export const GetMonitoringDataPaginated = async (
  page: number,
  limit: number,
  filter?: { monitor_tag?: string; status?: MonitoringStatus; start_time?: number; end_time?: number },
): Promise<{ data: MonitoringData[]; total: number }> => {
  const data = await db.getMonitoringDataPaginated(page, limit, filter);
  const countResult = await db.getMonitoringDataCount(filter);
  return { data, total: countResult.count };
};

export type BadgeType = "status" | "uptime" | "latency";

export interface BadgeParams {
  tag: string;
  sinceLast?: string | null;
  hideDuration?: string | null;
  label?: string | null;
  labelColor?: string | null;
  color?: string | null;
  style?: string | null;
  metric?: string | null;
  locale?: string | null;
}

function formatDuration(rangeInSeconds: number): string {
  const days = Math.floor(rangeInSeconds / 86400);
  const hours = Math.floor((rangeInSeconds % 86400) / 3600);
  const minutes = Math.floor((rangeInSeconds % 3600) / 60);

  if (days > 0 || minutes < 1) {
    return `${days}d`;
  } else if (hours > 0) {
    return `${hours}h`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  }
  return "";
}

export const GetBadge = async (badgeType: BadgeType, params: BadgeParams): Promise<Response> => {
  const nameInUrl = params.tag;

  if (!nameInUrl) {
    return new Response(ErrorSvg, {
      headers: { "Content-Type": "image/svg+xml" },
    });
  }

  // I3e: badge URLs carry the monitor's per-org slug. Resolved here rather than
  // in each of the four badge routes, because all four funnel through this
  // function and a fifth badge type would otherwise have to remember.
  //
  // `_` is the reserved "all monitors" token and is not a monitor name, so it is
  // passed through untouched. For the default org every other name resolves to
  // itself, which is what keeps a badge embedded in somebody's README working.
  const tag = nameInUrl === "_" ? nameInUrl : ((await ResolvePublicMonitorTag(nameInUrl)) ?? nameInUrl);

  let name: string;
  let message: string;
  let badgeColor: string = params.color || "#0079FF";

  // For status badge, we get real-time status
  if (badgeType === "status") {
    let lastObj: { status: string } | undefined;

    if (tag === "_") {
      // All monitors status
      const siteData = await db.getSiteDataByKey("siteName");
      name = (siteData?.value as string) || "All Monitors";
      lastObj = await GetLatestStatusActiveAll();
    } else {
      // Single monitor status
      const monitors = await GetMonitorsParsed({ tag, status: GC.ACTIVE, is_hidden: GC.NO });
      if (monitors.length === 0) {
        return new Response(ErrorSvg, {
          headers: { "Content-Type": "image/svg+xml" },
        });
      }
      const m = monitors[0];
      name = m.name;
      lastObj = (await GetLastMonitoringValue(m.tag, () => GetLatestMonitoringData(m.tag))) as { status: string };
    }

    const status = (lastObj?.status as string) || GC.NO_DATA;

    // Resolve locale: validate against activated locales, fall back to configured default
    const i18nData = await db.getSiteDataByKey("i18n");
    let i18nConfig: { defaultLocale: string; locales: Array<{ code: string; selected: boolean }> } | null = null;
    if (i18nData?.value) {
      try {
        i18nConfig = typeof i18nData.value === "string" ? JSON.parse(i18nData.value) : i18nData.value;
      } catch {
        i18nConfig = null;
      }
    }
    const defaultLocale = i18nConfig?.defaultLocale || "en";
    const activatedCodes = new Set(i18nConfig?.locales?.filter((l) => l.selected).map((l) => l.code) ?? ["en"]);
    const requestedLocale = params.locale || defaultLocale;
    const locale =
      activatedCodes.has(requestedLocale) && isLocaleAvailable(requestedLocale) ? requestedLocale : defaultLocale;

    const statusLocaleKey: Record<string, string> = {
      [GC.UP]: "Operational",
      [GC.DEGRADED]: "Degraded",
      [GC.DOWN]: "Down",
      [GC.MAINTENANCE]: "Under Maintenance",
      [GC.NO_DATA]: "No Status Available",
    };
    message = translate(locale, statusLocaleKey[status] || status, defaultLocale);

    // Use status-specific color if no custom color provided
    if (!params.color) {
      //get site colors
      let myColors = {} as Record<string, string>;
      const siteColorsData = await db.getSiteDataByKey("colors");
      if (siteColorsData && siteColorsData.value) {
        try {
          myColors = JSON.parse(siteColorsData.value);
        } catch (e) {
          myColors = {};
        }
      }
      const statusColors: Record<string, string> = {
        UP: myColors.UP || "#00dfa2",
        DEGRADED: myColors.DEGRADED || "#e6ca61",
        DOWN: myColors.DOWN || "#ca3038",
        MAINTENANCE: myColors.MAINTENANCE || "#6679cc",
        NO_DATA: myColors.NO_DATA || "#9ca3af",
      };
      badgeColor = statusColors[status] || statusColors.NO_DATA;
    }
  } else {
    // For uptime/latency badges, we calculate over a time period
    let sinceLast: number;
    const sinceLastParam = params.sinceLast;
    if (sinceLastParam == undefined || isNaN(Number(sinceLastParam)) || Number(sinceLastParam) < 60) {
      sinceLast = 90 * 24 * 60 * 60;
    } else {
      sinceLast = Number(sinceLastParam);
    }
    const rangeInSeconds = sinceLast;
    const now = Math.floor(Date.now() / 1000);
    const since = GetMinuteStartNowTimestampUTC() - rangeInSeconds;

    const hideDuration = params.hideDuration === "true";
    const formatted = formatDuration(rangeInSeconds);

    let stats: TimestampStatusCount[] = [];
    let uptimeData: UptimeCalculatorResult = {
      uptime: "-",
      avgLatency: "-",
      maxLatency: "-",
      minLatency: "-",
    };

    if (tag === "_") {
      // All monitors badge
      const siteData = await db.getSiteDataByKey("siteName");
      const siteName = siteData?.value as string | undefined;
      name = siteName || "All Monitors";
      const goodMonitors = await GetMonitorsParsed({ status: GC.ACTIVE, is_hidden: GC.NO });
      const activeTags = goodMonitors.map((monitor) => monitor.tag);

      stats = await db.getStatusCountsByInterval(activeTags, since, now - since, 1);
      uptimeData = UptimeCalculator(stats);
    } else {
      // Single monitor badge
      const monitors = await GetMonitorsParsed({ tag, status: GC.ACTIVE, is_hidden: GC.NO });
      if (monitors.length === 0) {
        return new Response(ErrorSvg, {
          headers: { "Content-Type": "image/svg+xml" },
        });
      }
      const m = monitors[0];
      name = m.name;

      stats = await db.getStatusCountsByInterval(m.tag, since, now - since, 1);
      uptimeData = UptimeCalculator(
        stats,
        m.monitor_settings_json?.uptime_formula_numerator,
        m.monitor_settings_json?.uptime_formula_denominator,
      );
    }

    // Determine message based on badge type
    if (badgeType === "uptime") {
      message = uptimeData.uptime;
    } else {
      // latency badge - support metric param (average, maximum, minimum)
      const metric = params.metric || "average";
      if (metric === "maximum") {
        message = uptimeData.maxLatency;
      } else if (metric === "minimum") {
        message = uptimeData.minLatency;
      } else {
        message = uptimeData.avgLatency;
      }
    }

    // Build label with duration suffix for uptime/latency
    name = name + (hideDuration ? "" : ` ${formatted}`);
  }

  // Build final label
  let label: string = params.label || name;
  label = label.trim();

  const format = {
    label,
    message,
    color: badgeColor,
    labelColor: params.labelColor || "#333",
    style: getBadgeStyle(params.style ?? null),
  };
  const svg = makeBadge(format);

  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml" },
  });
};

//calculate uptime for last N rows
export const CalculateUptimeForLastNRows = async (
  tag: string | string[],
  lastX: number,
  numeratorStr: string,
  denominatorStr: string,
): Promise<number> => {
  const statusCounts = await db.getStatusCountsForLastN(tag, lastX);
  const uptime = UptimeCalculator([statusCounts], numeratorStr, denominatorStr);
  return UnparsePercentage(uptime.uptime);
};

export const IsUptimeGreaterThanXPercent = async (
  tag: string | string[],
  lastX: number,
  threshold: number,
  numeratorStr: string,
  denominatorStr: string,
): Promise<boolean> => {
  const uptimePercent = await CalculateUptimeForLastNRows(tag, lastX, numeratorStr, denominatorStr);
  return uptimePercent > threshold;
};

export const IsUptimeLessThanXPercent = async (
  tag: string | string[],
  lastX: number,
  threshold: number,
  numeratorStr: string,
  denominatorStr: string,
): Promise<boolean> => {
  const uptimePercent = await CalculateUptimeForLastNRows(tag, lastX, numeratorStr, denominatorStr);
  return uptimePercent < threshold;
};
export const GetStatusCountsByIntervalGroupedByMonitor = async (
  monitorTags: string[],
  startTimestamp: number,
  intervalInSeconds: number,
  numberOfPoints: number,
): Promise<Array<TimestampStatusCountByMonitor>> => {
  const fromRollups = await GetUptimeBucketsFromRollups(monitorTags, startTimestamp, intervalInSeconds, numberOfPoints);
  if (fromRollups) {
    const out: Array<TimestampStatusCountByMonitor> = [];
    for (const [monitor_tag, series] of fromRollups) {
      for (const point of series) out.push({ monitor_tag, ...point });
    }
    return out;
  }

  // **The fallback keeps the old cache, and the old cache's problems.** It is
  // reached only while the rollups are not usable - a fresh install whose
  // backfill has not finished, or an operator who has pulled the kill switch -
  // and replacing a cache nothing will use once this path is dead would be work
  // spent on the wrong side of the switch. See `cache/rollupCache.ts` for what
  // is wrong with it and what replaced it.
  const sortedTags = [...monitorTags].sort();
  const cacheKey = `status_counts_grouped:${sortedTags.join(",")}:${startTimestamp}:${intervalInSeconds}:${numberOfPoints}`;
  const cached = await getCache<Array<TimestampStatusCountByMonitor>>(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await db.getStatusCountsByIntervalGroupedByMonitor(
    monitorTags,
    startTimestamp,
    intervalInSeconds,
    numberOfPoints,
  );
  await setCache(cacheKey, result, 60);
  return result;
};
export const GetLastKnownStatus = async (monitor_tag: string): Promise<MonitoringData | undefined> => {
  return await db.getLastKnownStatus(monitor_tag);
};
