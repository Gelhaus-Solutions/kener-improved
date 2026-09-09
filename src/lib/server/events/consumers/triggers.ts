import db from "../../db/db.js";
import Mustache from "mustache";
import { GetAllSiteData } from "../../controllers/siteDataController.js";
import { GetTriggersByMonitorAlertConfigId } from "../../controllers/monitorAlertConfigController.js";
import { alertToVariables, siteDataToVariables } from "../../notification/notification_utils.js";
import { dispatchTrigger } from "../../notification/dispatchTrigger.js";
import type { TriggerMeta, TriggerRecord } from "../../types/db.js";
import type { EventConsumer, OutboxEvent, DeliveryTarget, DeliveryResult, DeliveryOptions } from "../types.js";

// Alert triggers as a consumer of the bus, running in shadow.
//
// Triggers are the older notification mechanism: per alert config, an operator
// attaches some number of email, webhook, Slack or Discord destinations, and
// `alertingQueue` fires them inline when an alert opens or closes. Two problems
// with that, both of which the bus fixes and neither of which this item is
// allowed to fix yet:
//
//   A failed trigger is invisible. `notifyQuietly` swallows the error on
//   purpose, because by the time it runs the alert state is committed and
//   throwing would fail the job without ever redelivering the message. So a
//   Slack webhook that has been 404ing for a month produces one log line per
//   alert and nothing an operator would ever find.
//
//   There is no retry. A receiver that is down for thirty seconds during an
//   outage - which is exactly when receivers are down - simply misses it.
//
// The bus gives both for free: a delivery row per trigger, a retry ladder, and
// the delivery log. Until the P6 cutover this consumer only rehearses.
//
// Unordered. Each trigger is a different destination belonging to a different
// system, and making a dead Discord webhook delay somebody's PagerDuty call
// would be a strictly worse product than the one that exists.

const CONSUMER_NAME = "triggers";

const ALERT_EVENTS = new Set(["monitor.alert_triggered", "monitor.alert_resolved"]);

function payloadOf(event: OutboxEvent): Record<string, unknown> {
  if (!event.payload) return {};
  try {
    const parsed = JSON.parse(event.payload);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseMeta(trigger: TriggerRecord): TriggerMeta | null {
  try {
    return JSON.parse(trigger.trigger_meta ?? "") as TriggerMeta;
  } catch {
    return null;
  }
}

/**
 * Renders one trigger's outbound message, with Mustache and nothing else.
 *
 * **Environment secrets are deliberately left unresolved.** The live senders run
 * `GetRequiredSecrets` over the body, the URL and the headers and substitute
 * real values out of the process environment before sending. Doing that here
 * would write those values into `event_deliveries.request_body`, where they
 * would sit in the database, in every backup, and on an admin screen that only
 * needs `webhooks.read` to open. A rehearsal is not worth turning the delivery
 * log into a credential store, so `$env.FOO` stays literal and the diff is
 * read knowing that.
 */
function renderTrigger(
  trigger: TriggerRecord,
  meta: TriggerMeta,
  variables: Record<string, string | number | boolean>,
): { body: string; headers: Record<string, string> } | null {
  const render = (template: string): string =>
    // Escaping off, matching every live sender: these bodies are JSON or plain
    // text, and HTML-escaping them would corrupt the payload rather than protect
    // anything.
    Mustache.render(template ?? "", variables, {}, { escape: (text) => text });

  switch (trigger.trigger_type) {
    case "email": {
      const to = (meta.to ?? "")
        .split(",")
        .map((address) => address.trim())
        .filter((address) => address.length > 0);
      // The live path skips a trigger with no addresses without a word. Matching
      // that keeps the diff honest.
      if (to.length === 0) return null;
      return {
        body: JSON.stringify({
          to,
          from: meta.from,
          subject: render(meta.email_subject ?? ""),
          html: render(meta.email_body ?? ""),
        }),
        headers: { to: to.join(", ") },
      };
    }
    case "webhook":
      return {
        body: render(meta.webhook_body ?? ""),
        headers: { url: meta.url ?? "", "content-type": "application/json" },
      };
    case "discord":
      return { body: render(meta.discord_body ?? ""), headers: { url: meta.url ?? "" } };
    case "slack":
      return { body: render(meta.slack_body ?? ""), headers: { url: meta.url ?? "" } };
    default:
      return null;
  }
}

export const triggersConsumer: EventConsumer = {
  name: CONSUMER_NAME,
  mode: "shadow",
  ordered: false,
  supportsDryRun: true,

  /** One target per trigger attached to the alert's config. */
  async targets(event: OutboxEvent): Promise<DeliveryTarget[]> {
    if (!ALERT_EVENTS.has(event.type)) return [];

    const configId = Number(payloadOf(event).config_id);
    if (!Number.isFinite(configId)) return [];

    const triggers = await GetTriggersByMonitorAlertConfigId(configId);
    return triggers.map((t) => ({ target_type: "trigger", target_id: String(t.id) }));
  },

  async deliver(event: OutboxEvent, target: DeliveryTarget, options?: DeliveryOptions): Promise<DeliveryResult> {
    const payload = payloadOf(event);
    const alertId = Number(payload.alert_id ?? event.aggregate_id);
    const configId = Number(payload.config_id);

    const [triggers, alert, config] = await Promise.all([
      db.getTriggersByIDs([Number(target.target_id)]),
      db.getMonitorAlertV2ById(alertId),
      db.getMonitorAlertConfigById(configId),
    ]);

    const trigger = triggers[0];
    if (!trigger) return { ok: false, error: `Trigger ${target.target_id} no longer exists`, permanent: true };
    if (!alert) return { ok: false, error: `Alert ${alertId} no longer exists`, permanent: true };
    if (!config) return { ok: false, error: `Alert config ${configId} no longer exists`, permanent: true };

    const meta = parseMeta(trigger);
    if (!meta) return { ok: false, error: `Trigger ${trigger.id} has unparseable meta`, permanent: true };

    const siteVars = siteDataToVariables(await GetAllSiteData());
    const alertVars = alertToVariables(config, alert, siteVars, String(payload.monitor_tag ?? ""));
    const variables = { ...alertVars, ...siteVars };
    const rendered = renderTrigger(trigger, meta, variables);

    if (options?.dryRun) {
      if (!rendered) {
        return {
          ok: false,
          error: `Nothing to send for trigger ${trigger.id} of type "${trigger.trigger_type}"`,
          permanent: true,
        };
      }
      return {
        ok: true,
        request_headers: rendered.headers,
        request_body: rendered.body,
        response_body: `Shadow: rendered ${trigger.trigger_type} trigger "${trigger.name}", not sent`,
      };
    }

    // Live. The four-branch send is `notification/dispatchTrigger.ts`, the same
    // call the alerting queue and the test button make, so a trigger delivered
    // from the bus is delivered by exactly the code that delivered it before.
    const result = await dispatchTrigger(trigger, variables);

    // The body recorded is the one rendered above, not the one sent, and the
    // difference is deliberate: `dispatchTrigger` returns no body because the
    // senders substitute `$env` secrets immediately before sending, and storing
    // that would put credentials in the delivery log. What is stored instead is
    // the same message with `$env.FOO` left literal - readable enough to explain
    // a failure, and safe to keep.
    const request = {
      request_headers: result.request_headers ?? rendered?.headers ?? null,
      request_body: rendered?.body ?? null,
      duration_ms: result.duration_ms,
    };

    if (result.ok) {
      return { ok: true, ...request, response_body: `Sent ${trigger.trigger_type} trigger "${trigger.name}"` };
    }

    // An unsupported type and a trigger with nothing to send both go straight to
    // DEAD. Neither can succeed on a retry, and both are configuration an
    // operator can fix on the triggers screen - which they can only do if the
    // row says so. The old path skipped both silently.
    return {
      ok: false,
      ...request,
      error: result.error ?? `Trigger ${trigger.id} could not be delivered`,
      permanent: result.unsupported || result.skipped,
    };
  },
};

export default triggersConsumer;
