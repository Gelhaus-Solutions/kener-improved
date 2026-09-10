import { GetAllSiteData, GetMonitoringDataPaginated, GetTriggerByID } from "$lib/server/controllers/controller.js";
import {
  type MonitorAlertConfigRecord,
  type MonitorAlertV2Record,
} from "$lib/server/controllers/monitorAlertConfigController.js";
import { dispatchTrigger } from "$lib/server/notification/dispatchTrigger.js";
import { alertToVariables, siteDataToVariables } from "$lib/server/notification/notification_utils";
import { ActionError } from "../../types.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Sends one trigger on demand, so an operator can see it arrive.
 *
 * The four-branch email/webhook/slack/discord dispatch this used to carry
 * verbatim now lives in `notification/dispatchTrigger.ts`, shared with
 * `alertingQueue` and the `triggers` consumer. It was flagged as known
 * duplication when this action was transcribed, and E-cut2 is where it went:
 * three copies of "how to send a trigger" was one more than the two that already
 * risked drifting.
 *
 * The alert below is fabricated on purpose. A test has no real alert to describe,
 * so it builds one that exercises every template variable a real notification
 * would fill in, which is the point of the button: an operator wants to know the
 * template renders and the endpoint accepts it, not what yesterday's outage said.
 */
export default {
  action: "testTrigger",
  handler: async (data: LegacyPayload) => {
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
      sla_target_id: null,
      burn_window_a: null,
      burn_threshold_a: null,
      burn_window_b: null,
      burn_threshold_b: null,
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

    const result = await dispatchTrigger(trigger, { ...templateAlertVars, ...templateSiteVars });

    // A test that quietly reports success when nothing was sent is worse than no
    // test at all, so the two non-sending outcomes are raised rather than
    // returned. The alerting path treats them as a row and carries on, because
    // there it must not abandon the triggers behind this one; here there is
    // nobody behind it and somebody is watching.
    if (result.unsupported || result.skipped) {
      throw new ActionError(400, result.error ?? `Nothing to send for a "${trigger.trigger_type}" trigger`);
    }
    if (!result.ok) {
      throw new ActionError(502, result.error ?? "The trigger could not be delivered");
    }

    return result.response;
  },
} satisfies ActionDefinition<LegacyPayload>;
