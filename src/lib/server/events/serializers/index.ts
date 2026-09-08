import db from "../../db/db.js";

// The wire shape of the things events are about.
//
// **This is the contract with every receiver, and it is not the database row.**
// That separation is the whole point: column names, nullability and internal
// flags change with every migration, and a webhook consumer that broke because
// a column was renamed is a webhook consumer that stops trusting the product.
// P4 in particular is going to add `org_id` to most of these tables and change
// what a "tag" means, and none of that may reach a payload.
//
// So each aggregate type gets an explicit projection: fields are listed by hand,
// renamed where the internal name is unhelpful, and anything internal is simply
// absent. Adding a field here is safe; removing or renaming one is a breaking
// change that needs a new `api_version`.

/** A URL a human can open, included so a Slack message can link straight to it. */
async function siteUrl(): Promise<string> {
  try {
    const { GetSiteURL } = await import("../../controllers/siteDataController.js");
    return await GetSiteURL();
  } catch {
    return "";
  }
}

async function serializeIncident(id: string): Promise<Record<string, unknown> | null> {
  const incident = await db.getIncidentById(Number(id));
  if (!incident) return null;

  const [monitors, comments, base] = await Promise.all([
    db.getIncidentMonitorsByIncidentID(Number(id)),
    db.getIncidentComments(Number(id)),
    siteUrl(),
  ]);

  return {
    id: incident.id,
    title: incident.title,
    state: incident.state,
    status: incident.status,
    incident_type: incident.incident_type,
    start_date_time: incident.start_date_time,
    end_date_time: incident.end_date_time,
    is_global: incident.is_global === "YES",
    url: base ? `${base}/incidents/${incident.id}` : null,
    // Components, named as the public page names them rather than as the join
    // table does.
    components: monitors.map((m) => ({ monitor_tag: m.monitor_tag, impact: m.monitor_impact })),
    updates: comments.map((c) => ({
      id: c.id,
      state: c.state,
      body: c.comment,
      commented_at: c.commented_at,
      // `status` internally, but it only ever expresses visibility.
      visible: c.status !== "INACTIVE",
    })),
  };
}

async function serializeMaintenanceEvent(id: string): Promise<Record<string, unknown> | null> {
  const event = await db.getMaintenanceEventById(Number(id));
  if (!event) return null;
  const [maintenance, base] = await Promise.all([db.getMaintenanceById(event.maintenance_id), siteUrl()]);

  return {
    id: event.id,
    maintenance_id: event.maintenance_id,
    title: maintenance?.title ?? null,
    description: maintenance?.description ?? null,
    status: event.status,
    start_date_time: event.start_date_time,
    end_date_time: event.end_date_time,
    url: base ? `${base}/maintenances/${event.maintenance_id}` : null,
  };
}

async function serializeMaintenance(id: string): Promise<Record<string, unknown> | null> {
  const maintenance = await db.getMaintenanceById(Number(id));
  if (!maintenance) return null;
  const base = await siteUrl();
  return {
    id: maintenance.id,
    title: maintenance.title,
    description: maintenance.description,
    status: maintenance.status,
    start_date_time: maintenance.start_date_time,
    // The RRULE is deliberately included: a receiver building its own calendar
    // needs the recurrence, not just the next occurrence.
    rrule: maintenance.rrule,
    duration_seconds: maintenance.duration_seconds,
    url: base ? `${base}/maintenances/${maintenance.id}` : null,
  };
}

async function serializeMonitor(tag: string): Promise<Record<string, unknown> | null> {
  const monitor = await db.getMonitorByTag(tag);
  if (!monitor) return null;
  const base = await siteUrl();
  return {
    tag: monitor.tag,
    name: monitor.name,
    description: monitor.description,
    monitor_type: monitor.monitor_type,
    status: monitor.status,
    // Never the monitor's own configuration: `type_data` holds request bodies,
    // headers and credentials for the thing being checked, and a status-page
    // webhook is the last place any of that belongs.
    url: base ? `${base}/monitors/${monitor.tag}` : null,
  };
}

async function serializeMonitorAlert(id: string): Promise<Record<string, unknown> | null> {
  const alert = await db.getMonitorAlertV2ById(Number(id));
  if (!alert) return null;
  const config = await db.getMonitorAlertConfigById(alert.config_id);
  return {
    id: alert.id,
    config_id: alert.config_id,
    monitor_tag: alert.monitor_tag,
    alert_status: alert.alert_status,
    incident_id: alert.incident_id,
    severity: config?.severity ?? null,
    alert_for: config?.alert_for ?? null,
    alert_value: config?.alert_value ?? null,
  };
}

type Serializer = (id: string) => Promise<Record<string, unknown> | null>;

const SERIALIZERS: Record<string, Serializer> = {
  incident: serializeIncident,
  maintenance_event: serializeMaintenanceEvent,
  maintenance: serializeMaintenance,
  monitor: serializeMonitor,
  monitor_alert: serializeMonitorAlert,
};

/**
 * The public object an event is about, or null.
 *
 * Null is a normal outcome, not an error: a `*.deleted` event is about something
 * that no longer exists by the time delivery runs, and an aggregate type with no
 * serializer (the administrative ones) has no public shape by design. The
 * envelope carries the stored payload in both cases, so a receiver is never left
 * with nothing.
 */
export async function serializeAggregate(
  aggregateType: string | null,
  aggregateId: string | null,
): Promise<Record<string, unknown> | null> {
  if (!aggregateType || !aggregateId) return null;
  const serializer = SERIALIZERS[aggregateType];
  if (!serializer) return null;
  try {
    return await serializer(aggregateId);
  } catch (error) {
    // A payload that cannot be built must not stop the delivery: the receiver
    // still gets the type, the id and the diff, which is enough to go and look.
    console.error(`events: could not serialize ${aggregateType}/${aggregateId}:`, error);
    return null;
  }
}

/** Aggregate types with a public projection, for tests and for the docs. */
export function serializableAggregateTypes(): string[] {
  return Object.keys(SERIALIZERS);
}
