import db from "../../db/db.js";
import seedSiteData from "../../db/seedSiteData.js";
import { GetAllSiteData } from "../../controllers/siteDataController.js";
import { GetGeneralEmailTemplateById } from "../../controllers/generalTemplateController.js";
import { ResolveRecipients, type RecipientQuery } from "../../controllers/userSubscriptionsController.js";
import { maintenanceToVariables, siteDataToVariables } from "../../notification/notification_utils.js";
import emailQueue from "../../queues/emailQueue.js";
import mdToHTML from "../../../marked.js";
import { formatDistanceStrict } from "date-fns";
import type { SubscriptionVariableMap } from "../../notification/types.js";
import type { MaintenanceEventRecordDetailed } from "../../types/db.js";
import type { EventType } from "$lib/event-taxonomy.js";
import type { EventConsumer, OutboxEvent, DeliveryTarget, DeliveryResult, DeliveryOptions } from "../types.js";

// Subscriber email as a consumer of the bus.
//
// As of the P6 cutover this consumer can send for real. Which of the two paths
// actually sends is not decided here: it is decided by this consumer's mode in
// `site_data.eventBusConsumers`, and `subscriberQueue.push` refuses to do
// anything once that mode is `live`. Exactly one path sends at any moment, and
// which one is a row an operator can rewrite in seconds.
//
// The reason for that ceremony is that this is the change most able to fail
// invisibly. A webhook that stops arriving produces a complaint from an engineer
// watching a queue. A subscriber notification that stops arriving produces
// nothing at all until a customer mentions, weeks later, that they did not hear
// about an outage. There is no error, no failed job and no alarm - the absence
// is the whole symptom. So the flip is not made on the strength of a code
// review; it is made from the delivery log, by comparing the SHADOW rows this
// consumer wrote against the `email` rows the old path wrote, and it is
// performed by an operator on the event consumers screen rather than by a
// deploy.
//
// **Three behaviour changes come with going live.** All three are improvements,
// and all three are things somebody will notice:
//
//   1. Maintenance notifications start actually deduping. The old path built a
//      stable `update_id` and then `subscriberQueue.push` appended `Date.now()`
//      to the dedup key, so nothing ever deduped. The event's
//      `idempotency_key` is a UNIQUE column keyed on
//      `<type>:<event id>:<transition_seq>`, which dedupes for real while still
//      letting a genuine re-entry into a status notify again.
//
//   2. The maintenance gate stops erasing history. Turning off a maintenance
//      email used to suppress the whole operation; now the event is always
//      recorded and only the mail is gated, so audit and webhooks still see it.
//
//   3. Comments on MAINTENANCE-type incidents now notify. The old path only
//      called `notifySubscribersOfComment` when `incident_type === "INCIDENT"`,
//      so a comment posted on a maintenance-type incident reached nobody. That
//      was not a decision anybody made; a comment on the public timeline is
//      public communication whatever the incident is typed as. Accepted
//      knowingly in P6, and it means slightly more mail than before rather than
//      less.
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

  // C1. The second incident-family event this consumer listens to, and the only
  // one gated on the row rather than on a site setting: a postmortem says for
  // itself whether publishing it should mail anybody, because the answer differs
  // per document. A routine write-up of a ten-minute blip is not worth a mail;
  // the account of the outage that took a customer down for a day is.
  //
  // Read from the payload rather than from the row, so a later edit to
  // `notify_subscribers` cannot retroactively change what an already-emitted
  // event meant.
  if (event.type === "postmortem.published") {
    return String(payloadOf(event).notify_subscribers ?? "NO") === "YES";
  }

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

  // The payload wins where it has an opinion. `maintenance.scheduled` is
  // rendered by the controller from the arguments it was handed, not from the
  // maintenance row, so it carries the two fields that can differ; every other
  // transition reads the row and leaves these unset, which falls through to the
  // row and matches. Reading the row unconditionally is what made the shadow
  // diff report BODY_DIFFERS on `update_text` for a created event whose parent
  // description had been passed as something else.
  //
  // Tested by presence rather than with `??`, and that distinction is the whole
  // point: `description` is legitimately `null` for a maintenance created
  // without one, and `null ?? row.description` quietly falls back to the row -
  // which is precisely the fallback being overridden. `in` separates "the
  // controller said nothing" from "the controller said nothing was there".
  const detailed: MaintenanceEventRecordDetailed = {
    ...maintenanceEvent,
    title: "title" in payload ? String(payload.title ?? "") : (maintenance?.title ?? ""),
    description:
      "description" in payload ? ((payload.description as string | null) ?? null) : (maintenance?.description ?? null),
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

/**
 * Rebuilds the postmortem notification from the event (C1).
 *
 * The mail is a short pointer rather than the whole document: a postmortem is
 * long-form, often several screens of markdown, and the thing a subscriber wants
 * in their inbox is "the write-up is out, here it is". The link goes to the
 * incident, because that is where a published postmortem is rendered.
 */
async function renderPostmortem(event: OutboxEvent): Promise<SubscriptionVariableMap | null> {
  const payload = payloadOf(event);
  const postmortemId = Number(payload.postmortem_id ?? event.aggregate_id);
  const incidentId = Number(payload.incident_id);
  if (!Number.isFinite(incidentId) || !Number.isFinite(postmortemId)) return null;

  const incident = await db.getIncidentById(incidentId);
  if (!incident) return null;

  const row = await db.getPostmortemById(postmortemId);
  if (!row) return null;

  const siteUrl = siteDataToVariables(await GetAllSiteData()).site_url;
  // The summary where there is one, the opening of the body otherwise. Rendered
  // through the same markdown pipeline as a comment, so the same sanitisation
  // applies and no second answer exists about what HTML may reach a mailbox.
  const blurb = row.summary?.trim() || (row.body_md ?? "").trim();

  return {
    title: row.title,
    cta_url: `${siteUrl}incidents/${incidentId}`,
    cta_text: "Read the postmortem",
    update_text: mdToHTML(blurb),
    update_subject: `[Postmortem] ${row.title}`,
    // Keyed on the postmortem rather than the incident, so a postmortem and a
    // comment on the same incident are never collapsed into one notification.
    update_id: `postmortem-${postmortemId}`,
    event_type: "incidents",
  };
}

async function renderVariables(event: OutboxEvent): Promise<SubscriptionVariableMap | null> {
  if (event.type === "incident.comment_added") return await renderIncidentComment(event);
  if (event.type === "postmortem.published") return await renderPostmortem(event);
  return await renderMaintenance(event);
}

/**
 * This delivery's row id, so the email worker can write its outcome onto it.
 *
 * `deliver()` receives the event and the target but not the row, and the row is
 * what the send outcome has to land on. The triple below is the delivery UNIQUE
 * minus the event, so it identifies exactly one row.
 *
 * Undefined when the lookup fails, and deliberately not an error: an email that
 * sends but cannot be traced back to its row is a worse outcome than a row that
 * stays DELIVERED because nothing corrected it. Losing the audit trail beats
 * losing the notification.
 */
async function findDeliveryId(eventId: string, target: DeliveryTarget): Promise<number | undefined> {
  try {
    const rows = await db.getEventDeliveriesByEventId(eventId);
    return rows.find(
      (r) => r.consumer === CONSUMER_NAME && r.target_type === target.target_type && r.target_id === target.target_id,
    )?.id;
  } catch (error) {
    console.error("subscribers consumer: could not resolve the delivery row id:", error);
    return undefined;
  }
}

/**
 * What this event is, in the terms `ResolveRecipients` needs (E1).
 *
 * The components an event touches, its severity and whether it is global are all
 * on rows rather than on the event, so this reads them. Worth the two queries:
 * without them every subscription is effectively ALL-scoped, which is the
 * behaviour E1 exists to replace.
 *
 * **Existing subscribers are unaffected**, which is what keeps the shadow diff
 * meaningful for an instance still running this consumer in `shadow`. The
 * migration backfills every inherited subscription as ALL scope with no severity
 * floor, so the scoped query resolves exactly the set the unscoped one did until
 * somebody creates a scoped subscription on purpose.
 */
async function recipientQueryFor(event: OutboxEvent): Promise<RecipientQuery> {
  const payload = payloadOf(event);

  // Both incident-family events resolve recipients the same way, because a
  // postmortem inherits its incident's scope entirely: the components it is
  // about, the severity it carries and whether it was global are all facts about
  // the incident, not about the document.
  if (event.type === "incident.comment_added" || event.type === "postmortem.published") {
    const incidentId = Number(payload.incident_id ?? event.aggregate_id);
    const incident = Number.isFinite(incidentId) ? await db.getIncidentById(incidentId) : undefined;
    const monitors = Number.isFinite(incidentId) ? await db.getIncidentMonitorsByIncidentID(incidentId) : [];
    return {
      event_class: "incidents",
      component_tags: monitors.map((m) => m.monitor_tag),
      severity: incident?.severity ?? "NONE",
      is_global: incident?.is_global === "YES",
    };
  }

  const maintenanceEventId = Number(payload.maintenance_event_id ?? event.aggregate_id);
  const maintenanceEvent = Number.isFinite(maintenanceEventId)
    ? await db.getMaintenanceEventById(maintenanceEventId)
    : null;
  const monitors = maintenanceEvent ? await db.getMonitorsByMaintenanceId(maintenanceEvent.maintenance_id) : [];
  const maintenance = maintenanceEvent ? await db.getMaintenanceById(maintenanceEvent.maintenance_id) : undefined;
  return {
    event_class: "maintenances",
    component_tags: monitors.map((m) => m.monitor_tag),
    // Deliberately absent: maintenances are not severity-filtered.
    is_global: maintenance?.is_global === "YES",
  };
}

export const subscribersConsumer: EventConsumer = {
  name: CONSUMER_NAME,
  // Still `shadow` as the declared default, and that is not an oversight.
  //
  // This value is only the fallback for an install whose `site_data` says
  // nothing about this consumer, and the seed migration writes a value on every
  // install, so in practice it is read almost never. When it *is* read, it is
  // being read because something is missing - and the safe answer to a missing
  // setting is the path that was already sending, not the new one. Shadow means
  // `subscriberQueue` keeps its job.
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

    const recipients = await ResolveRecipients(await recipientQueryFor(event));
    return recipients.map((r) => ({ target_type: "subscriber_method", target_id: String(r.subscriber_method_id) }));
  },

  async deliver(event: OutboxEvent, target: DeliveryTarget, options?: DeliveryOptions): Promise<DeliveryResult> {
    const variables = await renderVariables(event);
    if (!variables) {
      // A finding, not a failure to swallow: the consumer resolved a recipient
      // and then could not build the message. Recorded on the row so the diff
      // shows it, and permanent because a message that cannot be rebuilt now
      // will not rebuild in six hours either.
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

    // Shaped exactly like the object `subscriberQueue` handed to `emailQueue`,
    // which is what made the shadow diff a field-by-field comparison rather than
    // an approximate one. Keeping the shape now that this path owns the send
    // means a delivery row written before the cutover and one written after are
    // still the same kind of thing, so the retry in `email.ts` and the retry
    // here replay identically.
    const emailJob = {
      toEmails: [method.method_value],
      templateHtmlBody: template.template_html_body || "",
      templateSubject: template.template_subject || "Event Update",
      templateTextBody: template.template_text_body || "",
      variables: { ...siteDataToVariables(await GetAllSiteData()), ...variables },
    };

    const request = {
      request_headers: { to: method.method_value },
      request_body: JSON.stringify(emailJob),
    };

    if (options?.dryRun) {
      return { ok: true, ...request, response_body: "Shadow: resolved and rendered, not sent" };
    }

    // Live. The send itself still belongs to `emailQueue` - it owns SMTP, its
    // own retry and the rate limiting - so this hands off rather than sending
    // inline, exactly as `subscriberQueue` did.
    //
    // The delivery id goes with it so the email worker writes the real outcome
    // onto *this* row. Looked up rather than passed in because `deliver()` is
    // handed a target, not a row; `email.ts` resolves it the same way.
    const deliveryId = await findDeliveryId(event.event_id, target);
    await emailQueue.push({ ...emailJob, delivery_id: deliveryId });

    // Queued, not sent, and the response body says so. Returning ok here marks
    // the row DELIVERED and the email worker overwrites that with the real
    // verdict a moment later. That ordering is the same one `email.ts` has had
    // since H8c: claiming a send outcome the sender has not reached yet would be
    // worse than briefly claiming a queue outcome that is true.
    return { ok: true, ...request, response_body: "Queued for sending" };
  },
};

export default subscribersConsumer;
