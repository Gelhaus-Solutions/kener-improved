import { GetAllSiteData, GetMonitoringDataPaginated, GetTriggerByID } from "$lib/server/controllers/controller.js";
import { type MonitorAlertConfigRecord, type MonitorAlertV2Record } from "$lib/server/controllers/monitorAlertConfigController.js";
import sendDiscord from "$lib/server/notification/discord_notification.js";
import sendEmail from "$lib/server/notification/email_notification.js";
import { alertToVariables, siteDataToVariables } from "$lib/server/notification/notification_utils";
import sendSlack from "$lib/server/notification/slack_notification.js";
import sendWebhook from "$lib/server/notification/webhook_notification.js";
import { type TriggerMeta } from "$lib/server/types/db.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 *
 * **Known duplication, deliberately left in place.** The four-branch dispatch
 * below (email / webhook / discord / slack) is the same dispatch
 * `sendAlertNotifications` performs in `queues/alertingQueue.ts`. Two copies of
 * "how to deliver a trigger" is exactly the kind of thing that drifts, and P6
 * extracts it into `notification/dispatchTrigger.ts` for both callers.
 *
 * It is not extracted here because that is a behaviour change to the alerting
 * path, and this item is a transcription. What this file does do is keep the
 * dispatch as one self-contained block reading from `triggerMetaParsed` and the
 * template variables, so the swap is a deletion plus one call rather than an
 * untangling.
 */
export default {
  action: "testTrigger",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const trigger = await GetTriggerByID(data.trigger_id);
    const siteData = await GetAllSiteData();
    if (!trigger || !siteData) {
      throw new Error("Trigger not found");
    }
    //fetch the last monitor tag from monitoring data and use that for testing instead of "test-monitor"
    const lastMonitoringData = await GetMonitoringDataPaginated(1, 1);
    let testTag = "test-monitor";
    if (lastMonitoringData && lastMonitoringData.data && lastMonitoringData.data.length > 0) {
      testTag = lastMonitoringData.data[0].monitor_tag;
    }
    const triggerMetaParsed = JSON.parse(trigger.trigger_meta) as TriggerMeta;
    const testAlert: MonitorAlertConfigRecord = {
      id: 1,
      monitor_tag: testTag,
      alert_for: "STATUS",
      alert_value: "DOWN",
      failure_threshold: 1,
      success_threshold: 1,
      alert_description: "This is a test alert",
      create_incident: "NO",
      is_active: "YES",
      severity: "WARNING",
      created_at: new Date(),
      updated_at: new Date(),
    };
    const testAlertData: MonitorAlertV2Record = {
      id: 1,
      config_id: 1,
      monitor_tag: null,
      incident_id: 4,
      alert_status: Math.random() > 0.5 ? "TRIGGERED" : "RESOLVED",
      created_at: new Date(),
      updated_at: new Date(),
    };

    const templateSiteVars = siteDataToVariables(siteData);
    const templateAlertVars = alertToVariables(testAlert, testAlertData, templateSiteVars);
    if (trigger.trigger_type === "webhook") {
      resp = await sendWebhook(
        triggerMetaParsed.webhook_body,
        { ...templateAlertVars, ...templateSiteVars },
        triggerMetaParsed.url,
        JSON.stringify(triggerMetaParsed.headers),
      );
    } else if (trigger.trigger_type === "email") {
      const toAddresses = triggerMetaParsed.to
        .trim()
        .split(",")
        .map((addr) => addr.trim())
        .filter((addr) => addr.length > 0);
      resp = await sendEmail(
        triggerMetaParsed.email_body,
        triggerMetaParsed.email_subject,
        { ...templateAlertVars, ...templateSiteVars },
        toAddresses,
        triggerMetaParsed.from,
      );
    } else if (trigger.trigger_type === "discord") {
      resp = await sendDiscord(
        triggerMetaParsed.discord_body,
        { ...templateAlertVars, ...templateSiteVars },
        triggerMetaParsed.url,
      );
    } else if (trigger.trigger_type === "slack") {
      resp = await sendSlack(
        triggerMetaParsed.slack_body,
        { ...templateAlertVars, ...templateSiteVars },
        triggerMetaParsed.url,
      );
    } else {
      throw new Error("Unsupported trigger type for testing");
    }
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
