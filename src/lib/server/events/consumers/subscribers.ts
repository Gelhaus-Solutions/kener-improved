import db from "../../db/db.js";
import seedSiteData from "../../db/seedSiteData.js";
import { GetAllSiteData } from "../../controllers/siteDataController.js";
import { GetGeneralEmailTemplateById } from "../../controllers/generalTemplateController.js";
import { GetActiveEmailMethodsForEventType } from "../../controllers/userSubscriptionsController.js";
import { maintenanceToVariables, siteDataToVariables } from "../../notification/notification_utils.js";
import mdToHTML from "../../../marked.js";
import { formatDistanceStrict } from "date-fns";
import type { SubscriptionVariableMap } from "../../notification/types.js";
import type { MaintenanceEventRecordDetailed } from "../../types/db.js";
import type { EventType } from "$lib/event-taxonomy.js";
import type { EventConsumer, OutboxEvent, DeliveryTarget, DeliveryResult, DeliveryOptions } from "../types.js";

// Subscriber email as a consumer of the bus, running in shadow.
//
// This consumer does not send anything and is not meant to. `subscriberQueue`
// still owns every subscriber notification the product actually delivers; what
// this does is work out, from the event alone, who *would* have been mailed and
// what they *would* have received, and record that beside the real send so the
// two can be compared.
//
// The reason for the ceremony is that this is the change most able to fail
// invisibly. A webhook that stops arriving produces a complaint from an engineer
// watching a queue. A subscriber notification that stops arriving produces
// nothing at all until a customer mentions, weeks later, that they did not hear
// about an outage. There is no error, no failed job and no alarm - the absence
// is the whole symptom. So the flip is not made on the strength of a code
// review; it is made once the shadow rows and the real deliveries have agreed
// for long enough, and the P6 item is what makes that call.
//
// The one subscription rule worth stating out loud, because getting it wrong
// doubles every automatic notification:
//
//   **incidents are notified from `incident.comment_added`, never from
//   `incident.created`.**
//
// The comment timeline is the incident's public communication channel, so
// posting a comment is the single event that mails subscribers, whoever posted
// it. An alert-driven incident goes through
// `CreateNewIncidentWithCommentAndMonitor`, which creates a comment, so it is
// already covered. Subscribing to `incident.created` as well would mail twice
// for every incident the alerting queue opens.

const CONSUMER_NAME = "subscribers";

/** How a maintenance event turns into the notification the old path sends. */
interface MaintenanceNotification {
  /** The key in `globalMaintenanceNotificationSettings.event_types`. */
  gate: "created" | "reminder" | "started" | "ended";
  statusMessage: string;
  updateIdSuffix: string;
  subjectPrefix: string;
}

/**
 * Transcribed from maintenanceController, deliberately literally.
 *
 * Every string here has a twin in the controller's `subscriberQueue.push` calls,
 * and they have to stay identical or the shadow diff reports a difference that
 * only exists because this file drifted. That is the failure mode worth guarding
 * against: a diff that cries wolf gets ignored, and an ignored diff is the same
 * as no shadow period at all.
 */
const MAINTENANCE_NOTIFICATIONS: Partial<Record<EventType, MaintenanceNotification>> = {
  "maintenance.scheduled": {
    gate: "created",
    statusMessage: "**has been created**",
    updateIdSuffix: "created",
    subjectPrefix: "Maintenance Created",
  },
  "maintenance.reminder": {
    gate: "reminder",
    // The real message interpolates how long until the window opens. Filled in
    // by `renderMaintenance`, which has the timestamps to compute it.
    statusMessage: "",
    updateIdSuffix: "starting_soon",
    subjectPrefix: "Maintenance Starting Soon",
  },
  "maintenance.started": {
    gate: "started",
    statusMessage: "**is now in progress**",
    updateIdSuffix: "ongoing",
    subjectPrefix: "Maintenance In Progress",
  },
  "maintenance.completed": {
    gate: "ended",
    statusMessage: "**has been completed**",
    updateIdSuffix: "completed",
    subjectPrefix: "Maintenance Completed",
  },
  "maintenance.cancelled": {
    // Shares the `ended` gate with completion, matching `SetMaintenanceEventStatus`
    // where one branch handles both.
    gate: "ended",
    statusMessage: "**has been cancelled**",
    updateIdSuffix: "cancelled",
    subjectPrefix: "Maintenance Cancelled",
  },
};

function payloadOf(event: OutboxEvent): Record<string, unknown> {
  if (!event.payload) return {};
  try {
    const parsed = JSON.parse(event.payload);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The maintenance gates, with the same seed fallback the controller uses. */
async function maintenanceGates(): Promise<Record<string, boolean>> {
  const siteData = await GetAllSiteData();
  const settings =
    (siteData as { globalMaintenanceNotificationSettings?: { event_types?: Record<string, boolean> } })
      .globalMaintenanceNotificationSettings ?? seedSiteData.globalMaintenanceNotificationSettings;
  return settings.event_types ?? {};
}

/**
 * True when the old path would have notified for this event at all.
 *
 * Applied in `targets()` rather than in `deliver()` so a gated-off event
 * produces no delivery row whatsoever. A row saying "would have sent to nobody"
 * is indistinguishable from a row saying "resolved nobody because the query
 * broke", and the second is the bug this is looking for.
 */
async function isNotifiable(event: OutboxEvent): Promise<boolean> {
  if (event.type === "incident.comment_added") return true;

  const notification = MAINTENANCE_NOTIFICATIONS[event.type as EventType];
  if (!notification) return false;
  return (await maintenanceGates())[notification.gate] === true;
}

/** Rebuilds the incident comment notification from the event. */
async function renderIncidentComment(event: OutboxEvent): Promise<SubscriptionVariableMap | null> {
  const payload = payloadOf(event);
  const incidentId = Number(payload.incident_id ?? event.aggregate_id);
  const commentId = Number(payload.comment_id);
  if (!Number.isFinite(incidentId) || !Number.isFinite(commentId)) return null;

  const incident = await db.getIncidentById(incidentId);
  if (!incident) return null;

  const siteUrl = siteDataToVariables(await GetAllSiteData()).site_url;
  const comment = String(payload.comment ?? "");
  const state = String(payload.state ?? "");

  return {
    title: incident.title,
    cta_url: `${siteUrl}incidents/${incidentId}`,
    cta_text: "View Incident",
    // The stored comment markdown, rendered exactly as the live path renders it.
    update_text: mdToHTML(comment),
    update_subject: `[#${incidentId}:${state}] ${incident.title}`,
    update_id: String(commentId),
    event_type: "incidents",
  };
}

/** Rebuilds a maintenance notification from the event. */
async function renderMaintenance(event: OutboxEvent): Promise<SubscriptionVariableMap | null> {
  const notification = MAINTENANCE_NOTIFICATIONS[event.type as EventType];
  if (!notification) return null;

  const payload = payloadOf(event);
  const maintenanceEventId = Number(payload.maintenance_event_id ?? event.aggregate_id);
  if (!Number.isFinite(maintenanceEventId)) return null;

  const maintenanceEvent = await db.getMaintenanceEventById(maintenanceEventId);
  if (!maintenanceEvent) return null;

  const maintenance = await db.getMaintenanceById(maintenanceEvent.maintenance_id);
  const monitors = await db.getMonitorsByMaintenanceId(maintenanceEvent.maintenance_id);
  const monitorNames = monitors.map((m) => `${m.monitor_name}(${m.monitor_impact})`).join(", ");
  const siteUrl = siteDataToVariables(await GetAllSiteData()).site_url;

  const detailed: MaintenanceEventRecordDetailed = {
    ...maintenanceEvent,
    title: maintenance?.title ?? "",
    description: maintenance?.description ?? null,
  } as MaintenanceEventRecordDetailed;

  let statusMessage = notification.statusMessage;
  if (event.type === "maintenance.reminder") {
    // The live path measures from "now" inside the scheduler tick that fired the
    // reminder. `occurred_at` is that same instant, so a rehearsal replayed
    // later still produces the phrase the recipient would have read, rather than
    // one that drifts with the age of the row.
    statusMessage = `**is starting in ${formatDistanceStrict(
      new Date(maintenanceEvent.start_date_time * 1000),
      new Date(event.occurred_at * 1000),
    )}**`;
  }

  return maintenanceToVariables(
    detailed,
    monitorNames,
    statusMessage,
    notification.updateIdSuffix,
    notification.subjectPrefix,
    siteUrl,
  );
}

async function renderVariables(event: OutboxEvent): Promise<SubscriptionVariableMap | null> {
  if (event.type === "incident.comment_added") return await renderIncidentComment(event);
  return await renderMaintenance(event);
}

export const subscribersConsumer: EventConsumer = {
  name: CONSUMER_NAME,
  // Shadow, and it stays shadow through P3 and P4. The flip is P6's decision and
  // it is made on evidence from the delivery log, not on this default.
  mode: "shadow",
  // Fan-out to independent recipients: one slow or broken address must never
  // hold up anyone else's mail.
  ordered: false,

  // Renders the full message without sending it, which is what makes the shadow
  // diff able to catch a template regression and not merely a recipient one.
  supportsDryRun: true,

  /**
   * One target per deliverable subscriber method.
   *
   * Keyed on the method rather than the address, matching `subscriberQueue`:
   * two subscribers can share an address, and collapsing them would make the
   * shadow row disagree with the live path for a reason that has nothing to do
   * with the bus.
   */
  async targets(event: OutboxEvent): Promise<DeliveryTarget[]> {
    if (!(await isNotifiable(event))) return [];

    const eventType = event.type === "incident.comment_added" ? "incidents" : "maintenances";
    const recipients = await GetActiveEmailMethodsForEventType(eventType);
    return recipients.map((r) => ({ target_type: "subscriber_method", target_id: String(r.subscriber_method_id) }));
  },

  async deliver(event: OutboxEvent, target: DeliveryTarget, options?: DeliveryOptions): Promise<DeliveryResult> {
    if (!options?.dryRun) {
      // Reachable only if somebody flips this consumer to `live` before the P6
      // work that makes live safe. Refusing is the right answer: going live also
      // requires `subscriberQueue` to stop sending, and without that every
      // subscriber gets each notification twice.
      return {
        ok: false,
        error:
          "The subscribers consumer is shadow-only until the P6 cutover. Going live also requires subscriberQueue to stop sending, or every notification doubles.",
        permanent: true,
      };
    }

    const variables = await renderVariables(event);
    if (!variables) {
      // A finding, not a failure to swallow: the consumer resolved a recipient
      // and then could not build the message. Recorded on the row so the diff
      // shows it.
      return { ok: false, error: `Could not rebuild the notification for ${event.type}`, permanent: true };
    }

    const template = await GetGeneralEmailTemplateById("subscription_update");
    if (!template) {
      return { ok: false, error: "Subscription email template not found", permanent: true };
    }

    const method = await db.getSubscriberMethodById(Number(target.target_id));
    if (!method) {
      return { ok: false, error: `Subscriber method ${target.target_id} no longer exists`, permanent: true };
    }

    // Shaped exactly like the object `subscriberQueue` hands to `emailQueue`, so
    // the two are comparable field by field rather than approximately.
    const emailJob = {
      toEmails: [method.method_value],
      templateHtmlBody: template.template_html_body || "",
      templateSubject: template.template_subject || "Event Update",
      templateTextBody: template.template_text_body || "",
      variables: { ...siteDataToVariables(await GetAllSiteData()), ...variables },
    };

    return {
      ok: true,
      request_headers: { to: method.method_value },
      request_body: JSON.stringify(emailJob),
      response_body: "Shadow: resolved and rendered, not sent",
    };
  },
};

export default subscribersConsumer;
