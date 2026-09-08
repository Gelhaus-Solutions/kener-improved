// The closed taxonomy of everything the event bus can carry.
//
// **This file is deliberately not under `$lib/server`.** The webhook event
// picker (E10) is a client component and has to render this list, and SvelteKit
// refuses at build time to import anything from `$lib/server` into client code.
// The H8b plan named `src/lib/server/events/taxonomy.ts` while also requiring
// client importability, which cannot both be true; this is the half that works.
// It sits beside `global-constants.ts` for exactly the reason that file does.
//
// Keep it free of imports that reach the server. It must stay pure data.
//
// **The set is closed on purpose.** An open string means two subsystems
// eventually emit `incident.update` and `incident.updated` and a customer's
// webhook filter silently stops matching. Adding a type here is a deliberate
// act, and `isEventType` is what a webhook subscription validates against.

/**
 * Incident lifecycle.
 *
 * `resolved` is deliberately its own type even though it always fires alongside
 * a `state_changed`. It is the one thing subscribers overwhelmingly filter on,
 * and making them express that as "state_changed where state == RESOLVED" would
 * push a payload condition into every subscription.
 */
export const INCIDENT_EVENTS = [
  "incident.created",
  "incident.updated",
  "incident.state_changed",
  "incident.severity_changed",
  "incident.component_impact_changed",
  "incident.comment_added",
  "incident.comment_updated",
  "incident.comment_hidden",
  "incident.resolved",
  "incident.reopened",
  "incident.deleted",
  "incident.backfilled",
] as const;

/** Postmortems. Reserved by C1; nothing emits these yet. */
export const POSTMORTEM_EVENTS = [
  "postmortem.drafted",
  "postmortem.updated",
  "postmortem.published",
  "postmortem.unpublished",
] as const;

export const MAINTENANCE_EVENTS = [
  "maintenance.scheduled",
  "maintenance.reminder",
  "maintenance.started",
  "maintenance.completed",
  "maintenance.cancelled",
  "maintenance.updated",
  "maintenance.deleted",
] as const;

/**
 * Monitors.
 *
 * `monitor.status_changed` fires on an actual transition only, never on the
 * per-minute sample that confirms the status is unchanged. A status page checks
 * hundreds of monitors a minute; emitting per sample would put hundreds of
 * thousands of rows a day into the outbox to say nothing happened.
 */
export const MONITOR_EVENTS = [
  "monitor.status_changed",
  "monitor.alert_triggered",
  "monitor.alert_resolved",
  "monitor.created",
  "monitor.updated",
  "monitor.deleted",
  "monitor.paused",
  "monitor.resumed",
] as const;

/** Derived page state. Reserved by C2b; nothing emits this yet. */
export const PAGE_EVENTS = ["page.status_changed"] as const;

/** Probe fleet. Reserved by B1b/B1c; nothing emits these yet. */
export const PROBE_EVENTS = ["probe.connected", "probe.disconnected", "probe.offline", "probe.result_late"] as const;

/**
 * Administrative changes.
 *
 * These are emitted for the audit trail and are **not** offered to webhook
 * subscribers: they carry who-did-what about the instance's own configuration,
 * which is nobody's business but the operator's. `subscribableEventTypes()` is
 * what enforces that split.
 */
export const ADMIN_EVENTS = [
  "trigger.created",
  "trigger.updated",
  "trigger.deleted",
  "webhook_endpoint.created",
  "webhook_endpoint.updated",
  "webhook_endpoint.deleted",
  "subscriber.created",
  "subscriber.updated",
  "subscriber.deleted",
  "user.created",
  "user.updated",
  "user.deleted",
  "apikey.created",
  "apikey.updated",
  "apikey.deleted",
  "site_settings.updated",
  "role.permissions_changed",
] as const;

export const EVENT_TYPES = [
  ...INCIDENT_EVENTS,
  ...POSTMORTEM_EVENTS,
  ...MAINTENANCE_EVENTS,
  ...MONITOR_EVENTS,
  ...PAGE_EVENTS,
  ...PROBE_EVENTS,
  ...ADMIN_EVENTS,
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** The part before the dot: the kind of thing an event is about. */
export type EventDomain = "incident" | "postmortem" | "maintenance" | "monitor" | "page" | "probe" | "admin";

/**
 * What each event is about, for the `aggregate_type` column.
 *
 * Not derived from the type's prefix, because the admin events disagree with
 * theirs: `role.permissions_changed` is about a role, `site_settings.updated` is
 * about the instance. Reading it off the string would be wrong for exactly the
 * cases that matter.
 */
export const EVENT_AGGREGATE_TYPE: Record<EventType, string> = {
  "incident.created": "incident",
  "incident.updated": "incident",
  "incident.state_changed": "incident",
  "incident.severity_changed": "incident",
  "incident.component_impact_changed": "incident",
  "incident.comment_added": "incident",
  "incident.comment_updated": "incident",
  "incident.comment_hidden": "incident",
  "incident.resolved": "incident",
  "incident.reopened": "incident",
  "incident.deleted": "incident",
  "incident.backfilled": "incident",
  "postmortem.drafted": "postmortem",
  "postmortem.updated": "postmortem",
  "postmortem.published": "postmortem",
  "postmortem.unpublished": "postmortem",
  "maintenance.scheduled": "maintenance_event",
  "maintenance.reminder": "maintenance_event",
  "maintenance.started": "maintenance_event",
  "maintenance.completed": "maintenance_event",
  "maintenance.cancelled": "maintenance_event",
  "maintenance.updated": "maintenance",
  "maintenance.deleted": "maintenance",
  "monitor.status_changed": "monitor",
  "monitor.alert_triggered": "monitor_alert",
  "monitor.alert_resolved": "monitor_alert",
  "monitor.created": "monitor",
  "monitor.updated": "monitor",
  "monitor.deleted": "monitor",
  "monitor.paused": "monitor",
  "monitor.resumed": "monitor",
  "page.status_changed": "page",
  "probe.connected": "probe",
  "probe.disconnected": "probe",
  "probe.offline": "probe",
  "probe.result_late": "probe",
  "trigger.created": "trigger",
  "trigger.updated": "trigger",
  "trigger.deleted": "trigger",
  "webhook_endpoint.created": "webhook_endpoint",
  "webhook_endpoint.updated": "webhook_endpoint",
  "webhook_endpoint.deleted": "webhook_endpoint",
  "subscriber.created": "subscriber",
  "subscriber.updated": "subscriber",
  "subscriber.deleted": "subscriber",
  "user.created": "user",
  "user.updated": "user",
  "user.deleted": "user",
  "apikey.created": "api_key",
  "apikey.updated": "api_key",
  "apikey.deleted": "api_key",
  "site_settings.updated": "site_settings",
  "role.permissions_changed": "role",
};

const ADMIN_EVENT_SET: ReadonlySet<string> = new Set(ADMIN_EVENTS);
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Validates a string against the closed set. Use it wherever one arrives from outside. */
export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

/**
 * The events a webhook endpoint or a subscriber may subscribe to: everything
 * except the administrative ones. This is the list the E10 picker renders.
 */
export function subscribableEventTypes(): EventType[] {
  return EVENT_TYPES.filter((t) => !ADMIN_EVENT_SET.has(t));
}

/** True for an event that exists only to feed the audit trail. */
export function isAdminEventType(type: string): boolean {
  return ADMIN_EVENT_SET.has(type);
}

/** Groups the subscribable types for a picker that renders one section per domain. */
export function subscribableEventsByDomain(): { domain: string; types: EventType[] }[] {
  const groups = new Map<string, EventType[]>();
  for (const type of subscribableEventTypes()) {
    const domain = type.slice(0, type.indexOf("."));
    const existing = groups.get(domain);
    if (existing) existing.push(type);
    else groups.set(domain, [type]);
  }
  return [...groups].map(([domain, types]) => ({ domain, types }));
}
