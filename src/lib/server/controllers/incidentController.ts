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
import {
  COMPONENT_IMPACTS,
  componentImpactFromMonitorImpact,
  isComponentImpact,
  isIncidentSeverity,
  monitorImpactFor,
  type ComponentImpact,
} from "../incidents/impact.js";
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
  /** Customer impact, not rule severity. See incidents/impact.ts. */
  severity?: string;
  /** Pins the whole incident's component impact; null means derive it. */
  impact_override?: string | null;
  /** C7: an imported historical incident must not mail anyone. */
  suppress_notifications?: string;
  /** C4: the template this incident was opened from. */
  template_id?: number | null;
  /** C2c: when Kener first observed the problem. Only the alerting queue knows. */
  detected_at?: number | null;
  /**
   * C7: this incident describes something that already ended.
   *
   * The only thing it changes here is the end-date clamp. Suppression is a
   * separate field, because "this is historical" and "do not tell anyone" are
   * different claims and an importer might reasonably want the first without the
   * second - re-recording last week's outage that everyone already heard about.
   */
  backfill?: boolean;
  /** C7: the historical lifecycle, handed over whole. */
  acknowledged_at?: number | null;
  acknowledged_by_user_id?: number | null;
  identified_at?: number | null;
  mitigated_at?: number | null;
  resolved_at?: number | null;
}

interface IncidentUpdateInput {
  /**
   * C2c: when the transition this update represents actually happened.
   *
   * Separate from `end_date_time` because only one transition sets an end time
   * and all four need a timestamp. `AddIncidentComment` passes the comment's
   * `commented_at`, which is the operator's account of when the incident moved -
   * and for a backfilled timeline that is months ago. Defaulting to now would
   * stamp every imported transition with the moment of the import, which is
   * exactly the number C7 exists to avoid recording.
   */
  transition_at?: number;
  severity?: string;
  impact_override?: string | null;
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
): Promise<Array<{ monitor_tag: string; monitor_impact: string | null; component_impact: ComponentImpact }>> => {
  let incidentExists = await db.getIncidentById(incident_id);
  if (!incidentExists) {
    throw new Error(`Incident with id ${incident_id} does not exist`);
  }
  let incidentMonitors = await db.getIncidentMonitorsByIncidentID(incident_id);
  return incidentMonitors.map((m) => ({
    monitor_tag: m.monitor_tag,
    monitor_impact: m.monitor_impact,
    // Inferred rather than passed through when the column is empty, so a row
    // written before C2 and one written after look the same to every reader.
    // Callers can then treat `component_impact` as always present, which is what
    // stops the null-handling spreading into the UI and the webhook payload.
    component_impact: isComponentImpact(m.component_impact)
      ? m.component_impact
      : componentImpactFromMonitorImpact(m.monitor_impact),
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
      suppress: incidentExists.suppress_notifications === "YES",
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
    // A maintenance-typed incident defaults to MAINTENANCE rather than NONE, so
    // the two vocabularies agree without an operator having to say so twice.
    severity: isIncidentSeverity(data.severity)
      ? data.severity
      : data.incident_type === "MAINTENANCE"
        ? "MAINTENANCE"
        : "NONE",
    impact_override: isComponentImpact(data.impact_override) ? data.impact_override : null,
    suppress_notifications: data.suppress_notifications === "YES" ? "YES" : "NO",
    template_id: data.template_id ?? null,
    detected_at: data.detected_at ?? null,
    acknowledged_at: data.acknowledged_at ?? null,
    acknowledged_by_user_id: data.acknowledged_by_user_id ?? null,
    identified_at: data.identified_at ?? null,
    mitigated_at: data.mitigated_at ?? null,
    resolved_at: data.resolved_at ?? null,
  };

  // The inherited clamp: an INCIDENT-typed row is open by definition, so an end
  // time handed to the creator is discarded and only a RESOLVED comment can
  // close it.
  //
  // **C7 is the one exception, and it is explicit rather than inferred.** A
  // backfilled incident describes something that already ended, so it is created
  // closed - there is no live timeline to resolve. Nothing else gets to skip
  // this: an ordinary caller passing an end time is still a caller who has
  // misunderstood how incidents close.
  if (incident.incident_type === "INCIDENT" && !data.backfill) {
    incident.end_date_time = null;
  }

  //if endDateTime is provided and it is less than startDateTime, throw error
  //
  // Kept for backfill too, unlike what C7 suggests. An incident that ended
  // before it began is not a historical record, it is a typo, and the import
  // path is exactly where a typo arrives in bulk with nobody reading it.
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
      // C7. Recorded, never delivered. The event exists so the history is
      // complete and a replay is possible; no consumer sees it, so nobody is
      // mailed about an outage that ended last March.
      suppress: incident.suppress_notifications === "YES",
    });

    return {
      incident_id: newIncident.id,
    };
  });
};

function GetNowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * C2c: the lifecycle timestamps, stamped from the state the incident moved into.
 *
 * Three rules, and each one is a decision rather than an implementation detail:
 *
 * 1. **`identified_at` and `mitigated_at` are set once and never re-set.** They
 *    answer "when did we work this out", and an incident that slipped from
 *    IDENTIFIED back to INVESTIGATING did not un-identify itself. Guarding on
 *    null is what makes them agree with the `MIN(commented_at)` the migration
 *    used to backfill them.
 *
 * 2. **`resolved_at` moves.** An incident resolved, reopened and resolved again
 *    was over at the second one; keeping the first would report an MTTR that
 *    ends before the outage did. So a reopen clears it, exactly as it clears
 *    `end_date_time`, and the next resolve writes the later time.
 *
 * 3. **The transition matters, not the destination.** Everything here is guarded
 *    on the state having actually changed. `UpdateIncident` runs on every
 *    comment, so without that guard a second comment posted while the incident
 *    sits in MONITORING would re-stamp `mitigated_at` to now, and a long
 *    incident's mitigation would keep sliding forward until it resolved.
 *
 * The timestamp comes from `transition_at` where the caller gave one - the
 * comment's `commented_at`, the time the operator said the thing happened -
 * then `end_date_time`, then now. Using `Date.now()` unconditionally would put
 * every transition at the moment the row was written rather than the moment it
 * happened, and those differ by exactly as much as a backfilled timeline.
 */
function applyLifecycleTimestamps(
  before: Pick<IncidentRecord, "state" | "identified_at" | "mitigated_at" | "resolved_at">,
  updateObject: Partial<IncidentRecord> & { id: number },
  data: IncidentUpdateInput,
): void {
  const nextState = updateObject.state;
  if (nextState === before.state) return;

  const at = data.transition_at ?? data.end_date_time ?? GetNowSeconds();

  if (nextState === GC.IDENTIFIED && before.identified_at === null) {
    updateObject.identified_at = at;
  }
  if (nextState === GC.MONITORING && before.mitigated_at === null) {
    updateObject.mitigated_at = at;
  }
  if (nextState === GC.RESOLVED) {
    updateObject.resolved_at = at;
  } else if (before.state === GC.RESOLVED) {
    // Reopened. `AddIncidentComment` nulls `end_date_time` on this transition and
    // `resolved_at` has to follow it, or an open incident keeps reporting a
    // resolution time and every "resolved this month" count includes it.
    updateObject.resolved_at = null;
  }
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
    severity: isIncidentSeverity(data.severity) ? data.severity : incidentExists.severity,
    // `undefined` means "not mentioned, keep it"; an explicit `null` means
    // "clear it and go back to deriving". Collapsing the two would make an
    // override impossible to remove, since every other update omits the field.
    impact_override:
      data.impact_override === undefined
        ? incidentExists.impact_override
        : isComponentImpact(data.impact_override)
          ? data.impact_override
          : null,
    // C2c. Carried across explicitly rather than left undefined for knex to drop.
    // Leaving them out would preserve them by accident - knex omits an undefined
    // column - and `applyLifecycleTimestamps` below writes an explicit `null` to
    // clear `resolved_at` on a reopen, which only survives if this object is the
    // whole row rather than a partial one.
    detected_at: incidentExists.detected_at,
    acknowledged_at: incidentExists.acknowledged_at,
    acknowledged_by_user_id: incidentExists.acknowledged_by_user_id,
    identified_at: incidentExists.identified_at,
    mitigated_at: incidentExists.mitigated_at,
    resolved_at: incidentExists.resolved_at,
  };

  // Stamped only when the value moves, so it answers "when did this become
  // MAJOR" rather than "when was this incident last touched" - which `updated_at`
  // already answers and which would make the field useless for the MTTR
  // arithmetic C2c builds on it.
  if (updateObject.severity !== incidentExists.severity) {
    updateObject.severity_changed_at = GetNowSeconds();
  }

  applyLifecycleTimestamps(incidentExists, updateObject, data);

  return await db.withTransaction(async () => {
    const rows = await db.updateIncident(updateObject as IncidentRecord);

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of [
      "title",
      "start_date_time",
      "status",
      "state",
      "end_date_time",
      "is_global",
      "severity",
      "impact_override",
    ] as const) {
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
      // C7. Every event this update emits inherits the incident's suppression,
      // and it has to be every one: `AddIncidentComment` calls this on each
      // backfilled comment, so a single unsuppressed `incident.resolved` would
      // page everybody about an outage from last March.
      suppress: incidentExists.suppress_notifications === "YES",
    } as const;

    await emit({ ...base, type: "incident.updated" });

    // Its own type for the same reason `incident.resolved` has one: "tell me when
    // an incident becomes critical" is a subscription somebody wants to express
    // without writing a filter over a diff.
    if (incidentExists.severity !== updateObject.severity) {
      await emit({
        ...base,
        type: "incident.severity_changed",
        payload: {
          incident_id,
          severity: updateObject.severity,
          previous_severity: incidentExists.severity,
        },
      });
    }

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

/**
 * Attaches a monitor to an incident with an impact.
 *
 * **Accepts either vocabulary and stores both** (C2). A caller that names a
 * communication value - the admin UI, the API - has that value stored verbatim
 * and the mechanical one derived from it. A caller that still names a mechanical
 * value - the alerting queue, which knows a monitor is DOWN and nothing about how
 * to describe that to customers - gets the communication value inferred.
 *
 * Accepting both rather than forcing every caller onto the new vocabulary is what
 * keeps `alertingQueue` and the inherited API contract working unchanged. The
 * inference direction is the lossy one, which is fine here: an alert genuinely
 * has no better information than "this monitor is down".
 */
/**
 * C2c: a human takes ownership of an incident.
 *
 * **The only incident transition with no state change behind it**, which is why
 * it is its own controller function and its own event rather than a flag on
 * `UpdateIncident`. An incident sits in INVESTIGATING both before and after
 * somebody acknowledges it; what changes is that a person is now on it, and MTTA
 * is the number that says how long that took.
 *
 * Idempotent, and deliberately not re-stampable. A second acknowledgement is a
 * no-op rather than an overwrite, because MTTA measures the *first* human
 * response - letting a later acknowledger reset it would let an incident's MTTA
 * grow every time somebody else looked at it.
 */
export const AcknowledgeIncident = async (
  incident_id: number,
  user_id: number,
  acknowledged_at?: number,
): Promise<{ acknowledged_at: number; acknowledged_by_user_id: number }> => {
  const incident = await db.getIncidentById(incident_id);
  if (!incident) {
    throw new Error(`Incident with id ${incident_id} does not exist`);
  }

  if (incident.acknowledged_at !== null) {
    return {
      acknowledged_at: incident.acknowledged_at,
      acknowledged_by_user_id: incident.acknowledged_by_user_id ?? user_id,
    };
  }

  const at = acknowledged_at ?? GetNowSeconds();

  return await db.withTransaction(async () => {
    await db.updateIncident({
      ...incident,
      // `getIncidentById` omits `incident_source` by design, and `updateIncident`
      // never writes it, so the cast covers a column neither end touches.
      incident_source: "",
      id: incident_id,
      acknowledged_at: at,
      acknowledged_by_user_id: user_id,
    } as IncidentRecord);

    await emit({
      org_id: currentOrgId(),
      type: "incident.acknowledged",
      aggregate_id: incident_id,
      payload: { incident_id, acknowledged_at: at, acknowledged_by_user_id: user_id },
      diff: { before: { acknowledged_at: null }, after: { acknowledged_at: at } },
      // One acknowledgement per incident, ever. Without this a retried request
      // would emit twice for a transition that happened once.
      idempotency_key: `incident.acknowledged:${incident_id}`,
    });

    return { acknowledged_at: at, acknowledged_by_user_id: user_id };
  });
};

export const AddIncidentMonitor = async (
  incident_id: number,
  monitor_tag: string,
  impact: string,
): Promise<number[]> => {
  // One of the five communication values, or one of the three mechanical ones
  // inferred into the five. Anything else is rejected, which preserves the
  // inherited guarantee that a typo cannot reach the column.
  const component_impact = isComponentImpact(impact) ? impact : componentImpactFromMonitorImpact(impact);
  if (!isComponentImpact(impact) && component_impact === "OPERATIONAL" && impact !== "OPERATIONAL") {
    throw new Error(
      `Impact must be one of ${COMPONENT_IMPACTS.join(", ")} or ${[GC.DOWN, GC.DEGRADED, GC.MAINTENANCE].join(", ")}`,
    );
  }
  const monitor_impact = monitorImpactFor(component_impact);

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
  const existingRow = existing.find((m) => m.monitor_tag === monitor_tag);
  // Compared on the communication layer, because that is what changed for the
  // reader. Keying this on `monitor_impact` would miss a move between
  // DEGRADED_PERFORMANCE and PARTIAL_OUTAGE entirely - both project onto
  // DEGRADED - and that move is precisely the kind of update a status page
  // exists to publish. Rows written before C2 have no `component_impact`, so
  // they are inferred rather than read as null, or the first write after the
  // migration would report a change nobody made.
  const previous: ComponentImpact | null = existingRow
    ? isComponentImpact(existingRow.component_impact)
      ? existingRow.component_impact
      : componentImpactFromMonitorImpact(existingRow.monitor_impact)
    : null;

  return await db.withTransaction(async () => {
    const result = await db.insertIncidentMonitorWithMerge({
      incident_id,
      monitor_tag,
      monitor_impact,
      component_impact,
    });

    // Only when the impact actually moved. Re-asserting the same impact is what
    // the alerting path does on every evaluation, and it is not news.
    if (previous !== component_impact) {
      await emit({
        org_id: currentOrgId(),
        type: "incident.component_impact_changed",
        aggregate_id: incident_id,
        // Both layers on the wire. A receiver rendering a status page wants the
        // communication value; one reconciling against the timeline wants the
        // mechanical one, and deriving it themselves would mean reimplementing
        // the projection outside this codebase.
        payload: { incident_id, monitor_tag, component_impact, monitor_impact },
        diff: { before: { component_impact: previous }, after: { component_impact } },
        // C7. Attaching a component to a backfilled incident is part of writing
        // history, not news about it.
        suppress: incidentExists.suppress_notifications === "YES",
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
        // The comment's own timestamp, so the lifecycle stamp records when the
        // incident moved rather than when the row was written.
        transition_at: commented_at,
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
  /** The `incident.comment_added` event this notification belongs to. */
  eventId?: string,
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
    await subscriberQueue.push(
      variables,
      { deduplication: { id: `subscriber-incidents-${comment.id}` } },
      // Ties each recipient's delivery row back to the event, which is what puts
      // a failed subscriber email on the same screen as a failed webhook.
      { event_id: eventId, org_id: currentOrgId() },
    );
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

    const suppressed = incidentExists.suppress_notifications === "YES";

    const commentEvent = await emit({
      org_id: currentOrgId(),
      type: "incident.comment_added",
      aggregate_id: incident_id,
      payload: { incident_id, comment_id: c.id, state, commented_at, comment },
      // The comment is the incident's public timeline entry, so one comment must
      // notify exactly once even if the write is retried.
      idempotency_key: `incident.comment_added:${c.id}`,
      // C7. This is the event that would do the damage: `comment_added` is the
      // single thing the subscribers consumer mails on, so a backfilled timeline
      // of six comments is six emails about an outage nobody can act on.
      suppress: suppressed,
    });

    //update incident state
    if (c && incidentType === GC.INCIDENT) {
      let incidentUpdate: IncidentUpdateInput = {
        state: state,
        // The comment's own timestamp, so the lifecycle stamp records when the
        // incident moved rather than when the row was written.
        transition_at: commented_at,
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
      //
      // **The legacy path needs its own guard.** `suppress` stops the bus from
      // delivering anything, but this call does not go through the bus - it is
      // the pre-cutover sender, still live wherever the `subscribers` consumer
      // has not been flipped. Relying on the event flag alone would suppress
      // exactly the installs that had already migrated and mail everybody on the
      // ones that had not.
      if (!suppressed) {
        afterCommit(() => notifySubscribersOfComment(incidentExists, c, commentEvent.event_id));
      }
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
