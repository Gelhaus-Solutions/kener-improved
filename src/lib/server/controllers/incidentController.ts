import db from "../db/db.js";
import type {
  MonitorRecordInsert,
  TriggerRecordInsert,
  MonitoringDataInsert,
  MonitorAlertInsert,
  IncidentFilter,
  MonitorAlert,
  TriggerFilter,
  UserRecordInsert,
  UserRecord,
  MonitorRecordTyped,
  IncidentRecord,
  IncidentCommentRecord,
  MonitorAlertV2Record,
  MonitorAlertConfigRecord,
  DbTimestamp,
} from "../types/db.js";
import { parseDbTimestamp } from "../tool.js";
import GC from "../../global-constants.js";
import { getUnixTime, differenceInSeconds } from "date-fns";
import { siteDataToVariables } from "../notification/notification_utils.js";
import { GetAllSiteData } from "./siteDataController.js";
import subscriberQueue from "../queues/subscriberQueue.js";
import mdToHTML from "../../marked.js";
import type { SubscriptionVariableMap } from "../notification/types.js";
import { emit } from "../events/emit.js";
import { currentOrgId } from "../events/eventContext.js";
import { afterCommit } from "../db/trxContext.js";

interface IncidentsDashboardInput {
  page: number;
  limit: number;
  filter: {
    status: string;
  };
}

export interface IncidentInput {
  title: string;
  start_date_time: number;
  end_date_time?: number | null;
  status?: string;
  state?: string;
  incident_type?: string;
  incident_source?: string;
  is_global?: string;
}

interface IncidentUpdateInput {
  title?: string;
  start_date_time?: number;
  end_date_time?: number | null;
  status?: string;
  state?: string;
  is_global?: string;
}

export const GetIncidentsOpenHome = async (
  homeIncidentCount: number | null,
  start: number,
  end: number,
): Promise<unknown[]> => {
  homeIncidentCount = parseInt(String(homeIncidentCount));

  if (homeIncidentCount < 0) {
    homeIncidentCount = 0;
  }

  if (homeIncidentCount === 0) {
    return [];
  }
  let incidents = (await db.getRecentUpdatedIncidents(homeIncidentCount, start, end)) as (IncidentRecord & {
    monitors?: unknown[];
    comments?: unknown[];
  })[];
  for (let i = 0; i < incidents.length; i++) {
    incidents[i].monitors = await GetIncidentMonitors(incidents[i].id);
  }

  //get comments
  for (let i = 0; i < incidents.length; i++) {
    incidents[i].comments = await GetIncidentActiveComments(incidents[i].id);
  }

  return incidents;
};

export const GetIncidentComments = async (incident_id: number): Promise<IncidentCommentRecord[]> => {
  let incidentExists = await db.getIncidentById(incident_id);
  if (!incidentExists) {
    throw new Error(`Incident with id ${incident_id} does not exist`);
  }
  return await db.getIncidentComments(incident_id);
};
export const GetIncidentActiveComments = async (incident_id: number): Promise<IncidentCommentRecord[]> => {
  let incidentExists = await db.getIncidentById(incident_id);
  if (!incidentExists) {
    throw new Error(`Incident with id ${incident_id} does not exist`);
  }
  return await db.getActiveIncidentComments(incident_id);
};

export const GetIncidentMonitors = async (
  incident_id: number,
): Promise<Array<{ monitor_tag: string; monitor_impact: string | null }>> => {
  let incidentExists = await db.getIncidentById(incident_id);
  if (!incidentExists) {
    throw new Error(`Incident with id ${incident_id} does not exist`);
  }
  let incidentMonitors = await db.getIncidentMonitorsByIncidentID(incident_id);
  return incidentMonitors.map((m) => ({
    monitor_tag: m.monitor_tag,
    monitor_impact: m.monitor_impact,
  }));
};

export const RemoveIncidentMonitor = async (incident_id: number, monitor_tag: string): Promise<number> => {
  let incidentExists = await db.getIncidentById(incident_id);
  if (!incidentExists) {
    throw new Error(`Incident with id ${incident_id} does not exist`);
  }
  return await db.withTransaction(async () => {
    // Removing a component from an incident is an impact change to NONE, not a
    // separate kind of event: a consumer tracking which components are affected
    // needs both halves to arrive on the same stream or it never clears them.
    await emit({
      org_id: currentOrgId(),
      type: "incident.component_impact_changed",
      aggregate_id: incident_id,
      payload: { incident_id, monitor_tag, monitor_impact: null },
    });
    return await db.removeIncidentMonitor(incident_id, monitor_tag);
  });
};

export const GetIncidentsDashboard = async (
  data: IncidentsDashboardInput,
): Promise<{ incidents: unknown[]; total: number }> => {
  let filter: IncidentFilter = {};
  if (data.filter.status != "ALL") {
    filter = { status: data.filter.status };
  }

  let incidents = (await db.getIncidentsPaginatedDesc(data.page, data.limit, filter)) as (IncidentRecord & {
    monitors?: unknown[];
    isAutoCreated?: boolean;
  })[];
  let totalResult = await db.getIncidentsCount(filter);
  let total = totalResult ? Number(totalResult.count) : 0;

  // Two batched queries for the whole page instead of two per row. The
  // per-incident helpers also re-checked that the incident existed, which these
  // rows demonstrably do, so that read disappears as well.
  const incidentIds = incidents.map((incident) => incident.id);
  const [monitorRows, autoCreatedIds] = await Promise.all([
    db.getIncidentMonitorsByIncidentIDs(incidentIds),
    db.alertExistsForIncidents(incidentIds),
  ]);

  const monitorsByIncidentId = new Map<number, Array<{ monitor_tag: string; monitor_impact: string | null }>>();
  for (const row of monitorRows) {
    const existing = monitorsByIncidentId.get(row.incident_id) || [];
    existing.push({ monitor_tag: row.monitor_tag, monitor_impact: row.monitor_impact });
    monitorsByIncidentId.set(row.incident_id, existing);
  }
  const autoCreated = new Set<number>(autoCreatedIds);

  for (const incident of incidents) {
    incident.monitors = monitorsByIncidentId.get(incident.id) || [];
    incident.isAutoCreated = autoCreated.has(incident.id);
  }

  return {
    incidents: incidents,
    total: total,
  };
};
export const GetIncidentByIDDashboard = async (data: {
  incident_id: number;
}): Promise<Omit<IncidentRecord, "incident_source"> | undefined> => {
  let incident = await db.getIncidentById(data.incident_id);

  return incident;
};
export const GetIncidentsPaginated = async (
  page: number,
  limit: number,
  filter: IncidentFilter,
  direction: "after" | "before",
): Promise<unknown[]> => {
  let incidents = (await db.getIncidentsPaginated(page, limit, filter, direction)) as (IncidentRecord & {
    monitors?: Array<{ monitor_tag: string; monitor_impact: string | null }>;
    comments?: unknown[];
  })[];

  let allMonitors: Record<string, unknown> = {};

  for (let i = 0; i < incidents.length; i++) {
    let incidentMonitors = await GetIncidentMonitors(incidents[i].id);
    incidents[i].monitors = incidentMonitors;
  }

  //for each monitor tag, in monitorsTagAndImpact for every incident, call get monitor by tag
  for (let i = 0; i < incidents.length; i++) {
    const monitors = incidents[i].monitors || [];
    for (let j = 0; j < monitors.length; j++) {
      let monitorTag = monitors[j].monitor_tag;
      let monitorImpact = monitors[j].monitor_impact;
      if (!allMonitors[monitorTag]) {
        let monitor = await db.getMonitorByTag(monitorTag);
        if (monitor) {
          allMonitors[monitorTag] = {
            id: monitor.id,
            tag: monitor.tag,
            name: monitor.name,
            image: monitor.image,
            impact_type: monitorImpact,
          };
        }
      }
      (incidents[i].monitors as unknown[])[j] = allMonitors[monitorTag];
    }
  }

  //get comments
  for (let i = 0; i < incidents.length; i++) {
    incidents[i].comments = await GetIncidentActiveComments(incidents[i].id);
  }

  return incidents;
};
export const GetIncidentsPage = async (start: number, open: number): Promise<unknown[]> => {
  let incidents = (await db.getIncidentsBetween(start, open)) as (IncidentRecord & {
    monitors?: unknown[];
    comments?: unknown[];
  })[];
  for (let i = 0; i < incidents.length; i++) {
    incidents[i].monitors = await GetIncidentMonitors(incidents[i].id);
  }

  //get comments
  for (let i = 0; i < incidents.length; i++) {
    incidents[i].comments = await GetIncidentActiveComments(incidents[i].id);
  }

  return incidents;
};
export const GetIncidentsByIDS = async (ids: number[]): Promise<unknown[]> => {
  if (ids.length == 0) {
    return [];
  }
  let incidents = (await db.getIncidentsByIds(ids)) as (IncidentRecord & {
    monitors?: unknown[];
    comments?: unknown[];
  })[];
  for (let i = 0; i < incidents.length; i++) {
    incidents[i].monitors = [];
  }

  //get comments
  for (let i = 0; i < incidents.length; i++) {
    incidents[i].comments = await GetIncidentActiveComments(incidents[i].id);
  }

  return incidents;
};

export const CreateNewIncidentWithCommentAndMonitor = async (
  data: IncidentInput,
  update: string,
  monitorTag: string,
  monitorStatus: string,
): Promise<{ incident_id: number }> => {
  let incidentCreation = await CreateIncident(data);
  await AddIncidentComment(incidentCreation.incident_id, update, GC.INVESTIGATING, data.start_date_time);
  await AddIncidentMonitor(incidentCreation.incident_id, monitorTag, monitorStatus);

  return incidentCreation;
};

export const IncidentCreateAlertMarkdown = (
  alert: MonitorAlertV2Record,
  config: MonitorAlertConfigRecord,
  monitorName: string,
  monitorTag: string,
  incidentState: string,
): string => {
  let update = config.alert_description || "Alert triggered";
  update = `${config.alert_description || "Alert triggered"}\n\n`;
  update = update + `| Setting | Value |\n`;
  update = update + `| :--- | :--- |\n`;
  update = update + `| **Monitor Name** | ${monitorName} |\n`;
  update = update + `| **Monitor Tag** | ${monitorTag} |\n`;
  update = update + `| **Incident Status** | ${incidentState} |\n`;
  update = update + `| **Severity** | ${config.severity} |\n`;
  update = update + `| **Alert Type** | ${config.alert_for} |\n`;
  update = update + `| **Alert Value** | ${config.alert_value} |\n`;
  update = update + `| **Failure Threshold** | ${config.failure_threshold} |\n`;
  return update;
};

export const ClosureCommentAlertMarkdown = (
  alert: MonitorAlertV2Record,
  config: MonitorAlertConfigRecord,
  monitorName: string,
  monitorTag: string,
  incidentState: string,
): string => {
  let comment = "The alert has been resolved";

  // Calculate duration in seconds between created_at and updated_at
  const durationInSeconds = differenceInSeconds(parseDbTimestamp(alert.updated_at), parseDbTimestamp(alert.created_at));
  const durationInMinutes = Math.round(durationInSeconds / 60);

  comment = comment + `, Total duration: ${durationInMinutes} minutes`;

  // Add alert details
  comment = comment + `\n\n#### Alert Details\n\n`;
  comment = comment + `| Setting | Value |\n`;
  comment = comment + `| :--- | :--- |\n`;
  comment = comment + `| **Monitor Name** | ${monitorName} |\n`;
  comment = comment + `| **Incident Status** | ${incidentState} |\n`;
  comment = comment + `| **Monitor Tag** | ${monitorTag} |\n`;
  comment = comment + `| **Alert Type** | ${config.alert_for} |\n`;
  comment = comment + `| **Alert Value** | ${config.alert_value} |\n`;
  comment = comment + `| **Severity** | ${config.severity} |\n`;
  comment = comment + `| **Failure Threshold** | ${config.failure_threshold} |\n`;
  comment = comment + `| **Success Threshold** | ${config.success_threshold} |\n`;

  return comment;
};

export const CreateIncident = async (data: IncidentInput): Promise<{ incident_id: number }> => {
  //return error if no title or startDateTime
  if (!data.title || !data.start_date_time) {
    throw new Error("Title and startDateTime are required");
  }

  let incident = {
    title: data.title,
    start_date_time: data.start_date_time,
    status: !!data.status ? data.status : "OPEN",
    end_date_time: !!data.end_date_time ? data.end_date_time : null,
    state: !!data.state ? data.state : "INVESTIGATING",
    incident_type: !!data.incident_type ? data.incident_type : "INCIDENT",
    incident_source: !!data.incident_source ? data.incident_source : "DASHBOARD",
    is_global: data.is_global || "YES",
  };

  //incident_type == INCIDENT delete endDateTime
  if (incident.incident_type === "INCIDENT") {
    incident.end_date_time = null;
  }

  //if endDateTime is provided and it is less than startDateTime, throw error
  if (!!incident.end_date_time && incident.end_date_time < incident.start_date_time) {
    throw new Error("End date time cannot be less than start date time");
  }

  return await db.withTransaction(async () => {
    const newIncident = await db.createIncident(incident);

    // `backfilled` rather than `created` when the incident describes something
    // that already ended. A subscriber wants to hear about an outage happening
    // now; being paged about one that was over before the record was typed up is
    // the fastest way to get notifications muted.
    const isBackfill = !!incident.end_date_time && incident.end_date_time <= GetNowSeconds();
    await emit({
      org_id: currentOrgId(),
      type: isBackfill ? "incident.backfilled" : "incident.created",
      aggregate_id: newIncident.id,
      payload: { ...incident, incident_id: newIncident.id },
    });

    return {
      incident_id: newIncident.id,
    };
  });
};

function GetNowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export const UpdateIncident = async (incident_id: number, data: IncidentUpdateInput): Promise<number> => {
  let incidentExists = await db.getIncidentById(incident_id);

  if (!incidentExists) {
    throw new Error(`Incident with id ${incident_id} does not exist`);
  }

  let endDateTime = data.end_date_time;
  if (endDateTime && endDateTime < incidentExists.start_date_time) {
    throw new Error("End date time cannot be less than start date time");
  }

  let updateObject: Partial<IncidentRecord> & { id: number } = {
    id: incident_id,
    title: data.title || incidentExists.title,
    start_date_time: data.start_date_time || incidentExists.start_date_time,
    status: data.status || incidentExists.status,
    state: data.state || incidentExists.state,
    end_date_time: data.end_date_time || incidentExists.end_date_time,
    is_global: data.is_global !== undefined ? data.is_global : incidentExists.is_global,
  };

  return await db.withTransaction(async () => {
    const rows = await db.updateIncident(updateObject as IncidentRecord);

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of ["title", "start_date_time", "status", "state", "end_date_time", "is_global"] as const) {
      const previous = (incidentExists as unknown as Record<string, unknown>)[key];
      const next = (updateObject as unknown as Record<string, unknown>)[key];
      if (previous === next) continue;
      before[key] = previous;
      after[key] = next;
    }

    // Nothing actually moved. `UpdateIncident` is called on every comment, so
    // without this an unchanged incident would emit on every timeline entry.
    if (Object.keys(after).length === 0) return rows;

    const base = {
      org_id: currentOrgId(),
      aggregate_id: incident_id,
      payload: { incident_id, title: updateObject.title, state: updateObject.state, status: updateObject.status },
      diff: { before, after },
    } as const;

    await emit({ ...base, type: "incident.updated" });

    const stateChanged = incidentExists.state !== updateObject.state;
    if (stateChanged) {
      await emit({ ...base, type: "incident.state_changed" });

      // Separate types rather than a payload condition, because "tell me when an
      // incident is resolved" is the single most common subscription there is
      // and it should not require a filter expression to express.
      if (updateObject.state === GC.RESOLVED) {
        await emit({ ...base, type: "incident.resolved" });
      } else if (incidentExists.state === GC.RESOLVED) {
        await emit({ ...base, type: "incident.reopened" });
      }
    }

    return rows;
  });
};

export const AddIncidentMonitor = async (
  incident_id: number,
  monitor_tag: string,
  monitor_impact: string,
): Promise<number[]> => {
  //monitor_impact must be DOWN or DEGRADED or MAINTENANCE or NONE
  if (
    ![GC.DOWN, GC.DEGRADED, GC.MAINTENANCE].includes(
      monitor_impact as typeof GC.DOWN | typeof GC.DEGRADED | typeof GC.MAINTENANCE,
    )
  ) {
    throw new Error("Monitor impact must be either DOWN, DEGRADED, MAINTENANCE");
  }

  //check if monitor exists
  let monitorExists = await db.getMonitorByTag(monitor_tag);
  if (!monitorExists) {
    throw new Error(`Monitor with tag ${monitor_tag} does not exist`);
  }

  //check if incident exists
  let incidentExists = await db.getIncidentById(incident_id);
  if (!incidentExists) {
    throw new Error(`Incident with id ${incident_id} does not exist`);
  }

  const existing = await db.getIncidentMonitorsByIncidentID(incident_id);
  const previous = existing.find((m) => m.monitor_tag === monitor_tag)?.monitor_impact ?? null;

  return await db.withTransaction(async () => {
    const result = await db.insertIncidentMonitorWithMerge({
      incident_id,
      monitor_tag,
      monitor_impact,
    });

    // Only when the impact actually moved. Re-asserting the same impact is what
    // the alerting path does on every evaluation, and it is not news.
    if (previous !== monitor_impact) {
      await emit({
        org_id: currentOrgId(),
        type: "incident.component_impact_changed",
        aggregate_id: incident_id,
        payload: { incident_id, monitor_tag, monitor_impact },
        diff: { before: { monitor_impact: previous }, after: { monitor_impact } },
      });
    }

    return result;
  });
};

export const UpdateCommentByID = async (
  incident_id: number,
  comment_id: number,
  comment: string,
  state: string,
  commented_at: number,
): Promise<number> => {
  let incidentExists = await db.getIncidentById(incident_id);
  if (!incidentExists) {
    throw new Error(`Incident with id ${incident_id} does not exist`);
  }
  let commentExists = await db.getIncidentCommentByIDAndIncident(incident_id, comment_id);
  if (!commentExists) {
    throw new Error(`Comment with id ${comment_id} does not exist`);
  }
  return await db.withTransaction(async () => {
    const c = await db.updateIncidentCommentByID(comment_id, comment, state, commented_at);
    if (c) {
      await emit({
        org_id: currentOrgId(),
        type: "incident.comment_updated",
        aggregate_id: incident_id,
        payload: { incident_id, comment_id, state, commented_at },
        diff: {
          before: { comment: commentExists.comment, state: commentExists.state },
          after: { comment, state },
        },
      });

      let incidentUpdate: IncidentUpdateInput = {
        state: state,
      };
      if (state === GC.RESOLVED) {
        incidentUpdate.end_date_time = commented_at;
      } else {
        if (incidentExists.state === GC.RESOLVED) {
          await db.setIncidentEndTimeToNull(incident_id);
        }
      }
      // Joins this transaction and emits its own state_changed/resolved events.
      await UpdateIncident(incident_id, incidentUpdate);
    }
    return c;
  });
};
// Subscriber notifications are driven solely by incident comments: the comment
// timeline is the incident's public communication channel, so posting a comment
// is the one event that emails "incidents" subscribers — regardless of whether
// the incident came from an alert, the dashboard, or the API. This is the single
// choke point; alertingQueue must not push its own incident notifications, or
// alert-driven incidents would notify twice.
const notifySubscribersOfComment = async (
  incident: Pick<IncidentRecord, "id" | "title">,
  comment: IncidentCommentRecord,
): Promise<void> => {
  try {
    const siteData = await GetAllSiteData();
    const siteUrl = siteDataToVariables(siteData).site_url;
    const variables: SubscriptionVariableMap = {
      title: incident.title,
      cta_url: `${siteUrl}incidents/${incident.id}`,
      cta_text: "View Incident",
      update_text: mdToHTML(comment.comment),
      update_subject: `[#${incident.id}:${comment.state}] ${incident.title}`,
      update_id: String(comment.id),
      event_type: "incidents",
    };
    // Stable dedup id per comment so a retried/double push notifies once — without
    // it subscriberQueue falls back to a Date.now()-suffixed id that never dedupes.
    await subscriberQueue.push(variables, {
      deduplication: { id: `subscriber-incidents-${comment.id}` },
    });
  } catch (err) {
    console.error(`Error sending subscriber notification for incident ${incident.id}:`, err);
  }
};

export const AddIncidentComment = async (
  incident_id: number,
  comment: string,
  state: string,
  commented_at: number,
): Promise<IncidentCommentRecord> => {
  let incidentExists = await db.getIncidentById(incident_id);
  if (!incidentExists) {
    throw new Error(`Incident with id ${incident_id} does not exist`);
  }

  if (!!!state) {
    state = incidentExists.state;
  }

  const incidentType = incidentExists.incident_type;

  return await db.withTransaction(async () => {
    const c = await db.insertIncidentComment(incident_id, comment, state, commented_at);

    await emit({
      org_id: currentOrgId(),
      type: "incident.comment_added",
      aggregate_id: incident_id,
      payload: { incident_id, comment_id: c.id, state, commented_at, comment },
      // The comment is the incident's public timeline entry, so one comment must
      // notify exactly once even if the write is retried.
      idempotency_key: `incident.comment_added:${c.id}`,
    });

    //update incident state
    if (c && incidentType === GC.INCIDENT) {
      let incidentUpdate: IncidentUpdateInput = {
        state: state,
      };
      if (state === GC.RESOLVED) {
        incidentUpdate.end_date_time = commented_at;
      } else {
        if (incidentExists.state === GC.RESOLVED) {
          await db.setIncidentEndTimeToNull(incident_id);
        }
      }
      await UpdateIncident(incident_id, incidentUpdate);

      // Deferred past the commit rather than awaited here. A queue push inside a
      // transaction can be picked up by a worker before the transaction commits,
      // and the worker then reads a comment that does not exist yet.
      afterCommit(() => notifySubscribersOfComment(incidentExists, c));
    }

    return c;
  });
};

export const UpdateCommentStatusByID = async (
  incident_id: number,
  comment_id: number,
  status: string,
): Promise<number> => {
  let commentExists = await db.getIncidentCommentByIDAndIncident(incident_id, comment_id);
  if (!commentExists) {
    throw new Error(`Comment with id ${comment_id} does not exist`);
  }
  return await db.withTransaction(async () => {
    const rows = await db.updateIncidentCommentStatusByID(comment_id, status);
    // The taxonomy calls this `comment_hidden` because hiding is the only thing
    // this status is ever used for; the payload carries the actual value so an
    // un-hide is distinguishable.
    await emit({
      org_id: currentOrgId(),
      type: "incident.comment_hidden",
      aggregate_id: incident_id,
      payload: { incident_id, comment_id, status },
      diff: { before: { status: commentExists.status }, after: { status } },
    });
    return rows;
  });
};

export const ParseIncidentToAPIResp = async (
  incident_id: number,
): Promise<{
  id: number;
  start_date_time: number;
  end_date_time: number | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
  title: string;
  status: string;
  state: string;
}> => {
  let incident = await db.getIncidentById(incident_id);
  if (!incident) {
    throw new Error(`Incident with id ${incident_id} not found`);
  }
  let resp = {
    id: incident.id,
    start_date_time: incident.start_date_time,
    end_date_time: incident.end_date_time,
    created_at: incident.created_at,
    updated_at: incident.updated_at,
    title: incident.title,
    status: incident.status,
    state: incident.state,
  };

  return resp;
};

export const DeleteIncident = async (incident_id: number): Promise<{ success: boolean }> => {
  const incident = await db.getIncidentById(incident_id);
  if (!incident) {
    throw new Error(`Incident with id ${incident_id} does not exist`);
  }

  // Set incident_id to null in monitor_alerts_v2
  const alerts = await db.getAlertsByIncidentId(incident_id);
  for (const alert of alerts) {
    await db.updateMonitorAlertV2(alert.id, { incident_id: null });
  }

  // Delete incident monitors
  const monitors = await db.getIncidentMonitorsByIncidentID(incident_id);
  for (const monitor of monitors) {
    await db.removeIncidentMonitor(incident_id, monitor.monitor_tag);
  }

  // Delete incident comments permanently
  await db.deleteIncidentCommentsByIncidentID(incident_id);

  return await db.withTransaction(async () => {
    // Before the delete, so the payload can still say what was removed. An
    // `incident.deleted` carrying nothing but an id leaves whoever has to
    // explain the gap in a public timeline with nothing to explain it from.
    await emit({
      org_id: currentOrgId(),
      type: "incident.deleted",
      aggregate_id: incident_id,
      payload: {
        incident_id,
        title: incident.title,
        state: incident.state,
        status: incident.status,
        start_date_time: incident.start_date_time,
        end_date_time: incident.end_date_time,
      },
    });

    await db.deleteIncident(incident_id);

    return { success: true };
  });
};
