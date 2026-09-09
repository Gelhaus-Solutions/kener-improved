import type { MonitoringResult } from "../types/monitor.js";
import { Queue, Worker, Job, type JobsOptions } from "bullmq";
import q from "./q.js";
import {
  CreateIncident,
  InsertMonitoringData,
  AddIncidentComment,
  AddIncidentMonitor,
  GetIncidentByIDDashboard,
  GetAllSiteData,
  CreateNewIncidentWithCommentAndMonitor,
  IncidentCreateAlertMarkdown,
  ClosureCommentAlertMarkdown,
  IsUptimeLessThanXPercent,
  IsUptimeGreaterThanXPercent,
} from "../controllers/controller.js";
import type { MonitorSettings, MonitorAlertConfigRecord, MonitorAlertV2Record } from "../types/db.js";
import { GetMonitorsParsed } from "../controllers/controller.js";
import {
  AddIncidentToAlert,
  CreateMonitorAlertV2,
  GetMonitorAlertConfigs,
  GetTriggersByMonitorAlertConfigId,
  UpdateMonitorAlertV2Status,
} from "../controllers/monitorAlertConfigController.js";
import type { IncidentInput } from "../controllers/incidentController.js";
import { GetMonitorAlertsV2 } from "../controllers/monitorAlertConfigController.js";
import db from "../db/db.js";
import { MayHaveAlertConfig } from "../cache/alertConfigTags.js";
import { getUnixTime, differenceInSeconds } from "date-fns";
import { parseDbTimestamp } from "../tool.js";
import GC from "../../global-constants.js";
import { dispatchTrigger } from "../notification/dispatchTrigger.js";
import { incidentSeverityFromAlertSeverity } from "../incidents/impact.js";
import { alertToVariables, siteDataToVariables } from "../notification/notification_utils.js";

import type { SiteDataForNotification } from "../notification/types.js";
import { emit } from "../events/emit.js";
import { currentOrgId } from "../events/eventContext.js";
import { recordLegacyDelivery } from "../events/legacyDeliveries.js";
import { ALERT_TRIGGER_CONSUMER } from "../events/consumers/alertTrigger.js";
import { effectiveMode } from "../events/consumers.js";
import triggersConsumer from "../events/consumers/triggers.js";
let alertingQueue: Queue | null = null;

let worker: Worker | null = null;
const queueName = "alertingQueue";
const jobNamePrefix = "alertingJob";

interface JobData {
  monitor_name: string;
  monitor_tag: string;
  monitor_settings: MonitorSettings;
  monitor_alerts_configured: MonitorAlertConfigRecord;
  monitor_type: string;
  monitor_image: string;
  monitor_id: number;
  monitor_description: string;
  numerator: string;
  denominator: string;
  ts: number;
  status: string;
}

async function createNewIncident(
  alert: MonitorAlertV2Record,
  config: MonitorAlertConfigRecord,
  monitorName: string,
  monitorTag: string,
): Promise<{ incident_id: number }> {
  let startDateTime = getUnixTime(parseDbTimestamp(alert.created_at));
  let incidentInput: IncidentInput = {
    title: monitorName + " " + config.alert_for + ": " + config.alert_value,
    start_date_time: startDateTime,
    incident_source: "ALERT",
    // Mapped at the boundary, once, and an operator can change it afterwards.
    // The alert vocabulary (CRITICAL|WARNING) describes how serious the rule
    // considers itself; incident severity describes customer impact. They are
    // deliberately not unified - see incidents/impact.ts - so this is a
    // translation rather than a copy.
    severity: incidentSeverityFromAlertSeverity(config.severity),
    // C2c. The alert row's creation time *is* the moment Kener first observed
    // the problem, so detection is knowable here and nowhere else. It is the
    // same instant as `start_date_time` today, and they are separate columns
    // because they answer different questions: an operator may correct the start
    // to when the outage really began, and doing so must not rewrite when we
    // found out - that gap is exactly what MTTD measures.
    detected_at: startDateTime,
  };

  // Subscriber notification comes from AddIncidentComment (via
  // CreateNewIncidentWithCommentAndMonitor) — do not push here too.
  let update = IncidentCreateAlertMarkdown(alert, config, monitorName, monitorTag, GC.TRIGGERED);
  let incidentCreated = await CreateNewIncidentWithCommentAndMonitor(
    incidentInput,
    update,
    monitorTag,
    config.alert_value,
  );

  return incidentCreated;
}

async function closeIncident(
  alert: MonitorAlertV2Record,
  config: MonitorAlertConfigRecord,
  monitorName: string,
  monitorTag: string,
): Promise<void> {
  //check if incident is already resolved
  if (!alert.incident_id) {
    console.log("No incident associated with this alert");
    return;
  }
  let incident = await GetIncidentByIDDashboard({
    incident_id: alert.incident_id,
  });
  if (!incident || incident.status === GC.CLOSED || incident.state === GC.RESOLVED) {
    console.log("Incident is already resolved or not found");
    return;
  }

  let incident_id = alert.incident_id;
  const comment = ClosureCommentAlertMarkdown(alert, config, monitorName, monitorTag, GC.RESOLVED);
  const updatedAt = getUnixTime(parseDbTimestamp(alert.updated_at));
  // Subscriber notification comes from AddIncidentComment — do not push here too.
  await AddIncidentComment(incident_id, comment, GC.RESOLVED, updatedAt);
}

async function sendAlertNotifications(
  activeAlert: MonitorAlertV2Record,
  monitor_alerts_configured: MonitorAlertConfigRecord,
  templateSiteVars: SiteDataForNotification,
  monitorTag?: string,
  /**
   * The alert event these notifications belong to, when the caller has one.
   *
   * Optional so anything that calls this without an event keeps working. When it
   * is present, each trigger gets a delivery row and a failure becomes visible
   * on the delivery log instead of being swallowed along with everything else
   * `notifyQuietly` catches.
   */
  eventId?: string,
): Promise<void> {
  // The cutover switch. Once the `triggers` consumer is live it resolves the
  // same triggers from the same event and sends them through the same
  // `dispatchTrigger`, so continuing here would notify every destination twice.
  //
  // Checked at the top rather than per trigger: a flip landing halfway through
  // this loop would send some of an alert's triggers from each path, which is
  // the one outcome worse than either path alone.
  if ((await effectiveMode(triggersConsumer)) === "live") {
    return;
  }

  const templateAlertVars = alertToVariables(monitor_alerts_configured, activeAlert, templateSiteVars, monitorTag);
  const triggers = await GetTriggersByMonitorAlertConfigId(monitor_alerts_configured.id);
  const orgId = currentOrgId();
  const variables = { ...templateAlertVars, ...templateSiteVars };

  for (const trigger of triggers) {
    const result = await dispatchTrigger(trigger, variables);

    // A skip writes no row, matching what this loop did before the delivery log
    // existed. An email trigger with its addresses deleted is a configuration
    // the operator can see on the triggers screen; a DEAD row per alert for it
    // would be noise on the one screen that must stay readable.
    if (eventId && !result.skipped) {
      await recordLegacyDelivery({
        event_id: eventId,
        org_id: orgId,
        consumer: ALERT_TRIGGER_CONSUMER,
        target_type: "trigger",
        target_id: String(trigger.id),
        ok: result.ok,
        error: result.error,
        request_headers: result.request_headers,
        duration_ms: result.duration_ms,
      });
    }

    // Preserved from before the delivery log existed: one bad trigger must not
    // stop the ones after it. An unsupported type used to `throw` here, which
    // abandoned every trigger queued behind it; `dispatchTrigger` returns it as
    // an ordinary failure instead, so the loop finishes.
    if (result.error) {
      console.error(
        `Trigger ${trigger.id} (${trigger.trigger_type}) failed for alert ${activeAlert.id}: ${result.error}`,
      );
    }
  }
}

const getQueue = () => {
  if (!alertingQueue) {
    alertingQueue = q.createQueue(queueName);
  }
  return alertingQueue;
};

/**
 * Evaluates whether the monitor currently violates the alert condition.
 *
 * Returns null for a config whose alert_for this build does not handle, which
 * the caller treats as "nothing to do" rather than an error.
 */
async function evaluateIsAffected(job: JobData, threshold: number): Promise<boolean | null> {
  const { monitor_tag, numerator, denominator, monitor_alerts_configured } = job;
  const alertValue = monitor_alerts_configured.alert_value;

  if (monitor_alerts_configured.alert_for === GC.STATUS) {
    //alertValue can be DOWN or DEGRADED
    return await db.consecutivelyStatusFor(monitor_tag, alertValue, threshold);
  }
  if (monitor_alerts_configured.alert_for === GC.LATENCY) {
    return await db.consecutivelyLatencyGreaterThan(monitor_tag, parseFloat(alertValue), threshold);
  }
  if (monitor_alerts_configured.alert_for === GC.UPTIME) {
    return await IsUptimeLessThanXPercent(monitor_tag, parseFloat(alertValue), threshold, numerator, denominator);
  }
  return null;
}

/** The recovery side of evaluateIsAffected: has the monitor been healthy long enough to resolve. */
async function evaluateIsRecovered(job: JobData, threshold: number): Promise<boolean> {
  const { monitor_tag, numerator, denominator, monitor_alerts_configured } = job;
  const alertValue = monitor_alerts_configured.alert_value;

  if (monitor_alerts_configured.alert_for === GC.STATUS) {
    return await db.consecutivelyStatusFor(monitor_tag, GC.UP, threshold);
  }
  if (monitor_alerts_configured.alert_for === GC.LATENCY) {
    return await db.consecutivelyLatencyLessThan(monitor_tag, parseFloat(alertValue), threshold);
  }
  if (monitor_alerts_configured.alert_for === GC.UPTIME) {
    return await IsUptimeGreaterThanXPercent(monitor_tag, parseFloat(alertValue), threshold, numerator, denominator);
  }
  return false;
}

/**
 * Sends the configured triggers, swallowing failures.
 *
 * Deliberately does not throw. By the time this runs the alert state is already
 * committed, and a retried job re-reads that state and finds nothing to do, so
 * throwing would fail the job without ever redelivering the message. Delivery
 * needs its own durable record to retry properly; that is what the P2 event bus
 * is for.
 */
async function notifyQuietly(
  activeAlert: MonitorAlertV2Record,
  config: MonitorAlertConfigRecord,
  templateSiteVars: SiteDataForNotification,
  monitorTag: string,
  eventId?: string,
): Promise<void> {
  try {
    await sendAlertNotifications(activeAlert, config, templateSiteVars, monitorTag, eventId);
  } catch (error) {
    console.error("Error sending alert notifications:", error);
  }
}

const addWorker = () => {
  if (worker) return worker;

  // Error handling here is deliberately not uniform, so read before widening a
  // catch. This queue is created with attempts: 3 and exponential backoff, and
  // wrapping the whole body in one catch (as it used to be) made every one of
  // those retries dead code: a transient database failure silently dropped an
  // alert. What throws and what does not:
  //
  //   evaluation    swallowed - a malformed config is permanent, and retrying
  //                 it three times only delays the same failure
  //   persistence   THROWS    - exactly what the retries exist for
  //   notification  swallowed - see notifyQuietly
  //
  // Anything added here that must not be lost (the P2 outbox emit, in
  // particular) belongs in the persistence section, unguarded.
  worker = q.createWorker(getQueue(), async (job: Job): Promise<void> => {
    const jobData = job.data as JobData;
    const { monitor_name, monitor_tag, monitor_alerts_configured } = jobData;
    const siteData = await GetAllSiteData();
    const templateSiteVars = siteDataToVariables(siteData);

    // ---- Evaluation ----------------------------------------------------
    let isAffected: boolean | null;
    try {
      isAffected = await evaluateIsAffected(jobData, monitor_alerts_configured.failure_threshold);
    } catch (error) {
      console.error("Error evaluating alert condition:", error);
      return;
    }
    if (isAffected === null) {
      return;
    }

    // ---- State and persistence -----------------------------------------
    // No try/catch by design. A throw fails the job and BullMQ retries it.
    const alertsExisting = await GetMonitorAlertsV2({
      config_id: monitor_alerts_configured.id,
      monitor_tag: monitor_tag,
      alert_status: GC.TRIGGERED,
    });
    let activeAlert: MonitorAlertV2Record | null = alertsExisting.length > 0 ? alertsExisting[0] : null;

    if (isAffected) {
      // Already alerting for this monitor and config; nothing to do.
      if (activeAlert) {
        return;
      }

      // The alert row and its event commit together. Without that, a crash
      // between the two loses the event permanently: the retried job finds the
      // alert already TRIGGERED and returns early, so nothing ever emits it.
      // This is the persistence section, so a throw here is a retry, by design.
      let triggeredEventId: string | undefined;
      activeAlert = await db.withTransaction(async () => {
        const created = await CreateMonitorAlertV2(monitor_alerts_configured.id, monitor_tag);
        const emitted = await emit({
          org_id: currentOrgId(),
          type: "monitor.alert_triggered",
          aggregate_id: created.id,
          // One alert row triggers exactly once, so its id is the natural key.
          idempotency_key: `monitor.alert_triggered:${created.id}`,
          payload: {
            alert_id: created.id,
            config_id: monitor_alerts_configured.id,
            monitor_tag,
            monitor_name,
            alert_for: monitor_alerts_configured.alert_for,
            alert_value: monitor_alerts_configured.alert_value,
            severity: monitor_alerts_configured.severity,
            failure_threshold: monitor_alerts_configured.failure_threshold,
          },
        });
        triggeredEventId = emitted.event_id;
        return created;
      });

      if (monitor_alerts_configured.create_incident === GC.YES) {
        const newIncidentNumber = await createNewIncident(
          activeAlert,
          monitor_alerts_configured,
          monitor_name,
          monitor_tag,
        );
        //update alert with incident number
        if (newIncidentNumber && newIncidentNumber.incident_id > 0) {
          activeAlert = await AddIncidentToAlert(activeAlert.id, newIncidentNumber.incident_id);
        }
      }

      await notifyQuietly(activeAlert, monitor_alerts_configured, templateSiteVars, monitor_tag, triggeredEventId);
      return;
    }

    // Not affected, and nothing outstanding to resolve.
    if (!activeAlert) {
      return;
    }

    let isUp: boolean;
    try {
      isUp = await evaluateIsRecovered(jobData, monitor_alerts_configured.success_threshold);
    } catch (error) {
      console.error("Error evaluating alert recovery:", error);
      return;
    }
    if (!isUp) {
      // Not yet recovered
      return;
    }

    //resolve the alert
    const alertToResolve = activeAlert;
    let resolvedEventId: string | undefined;
    activeAlert = await db.withTransaction(async () => {
      const resolved = await UpdateMonitorAlertV2Status(alertToResolve.id, GC.RESOLVED);
      const emitted = await emit({
        org_id: currentOrgId(),
        type: "monitor.alert_resolved",
        aggregate_id: resolved.id,
        idempotency_key: `monitor.alert_resolved:${resolved.id}`,
        payload: {
          alert_id: resolved.id,
          config_id: monitor_alerts_configured.id,
          monitor_tag,
          monitor_name,
          incident_id: resolved.incident_id,
          alert_for: monitor_alerts_configured.alert_for,
          alert_value: monitor_alerts_configured.alert_value,
          severity: monitor_alerts_configured.severity,
          success_threshold: monitor_alerts_configured.success_threshold,
        },
      });
      resolvedEventId = emitted.event_id;
      return resolved;
    });

    // If alert has an incident, add closure comment
    if (activeAlert.incident_id) {
      await closeIncident(activeAlert, monitor_alerts_configured, monitor_name, monitor_tag);
    }

    await notifyQuietly(activeAlert, monitor_alerts_configured, templateSiteVars, monitor_tag, resolvedEventId);
  });

  worker.on("completed", (job: Job, returnvalue: any) => {
    // const { monitor_tag, ts, status } = job.data as JobData;
    // console.log(`🚨 Alerting: ${monitor_tag} @ ${new Date(ts * 1000).toISOString()}`);
  });

  return worker;
};

export const push = async (monitor_tag: string, ts: number, status: string, options?: JobsOptions) => {
  if (!options) {
    options = {};
  }
  options.removeOnComplete = {
    age: 300, // keep up to 5 minutes
    count: 100, // keep up to 100 jobs
  };
  options.removeOnFail = {
    age: 24 * 3600, // keep up to 24 hours
  };
  const queue = getQueue();
  addWorker();

  // Most monitors have no alert config, and this runs for every datapoint of
  // every monitor every minute. One Redis lookup instead of the two queries
  // below. Answers true whenever it cannot be certain, so a Redis problem costs
  // queries rather than alerts.
  if (!(await MayHaveAlertConfig(monitor_tag))) {
    return;
  }

  //fetch monitorTyped from monitor_tag
  const monitors = await GetMonitorsParsed({ tag: monitor_tag });
  if (monitors.length === 0) {
    return;
  }
  const monitor = monitors[0];
  const monitorSettings = monitor.monitor_settings_json as MonitorSettings;

  //check if alerting is enabled for this monitor
  //get all monitor alert configs
  const monitorAlertsConfigurations = await GetMonitorAlertConfigs({
    monitor_tag: monitor.tag,
    is_active: GC.YES,
  });

  if (monitorAlertsConfigurations.length === 0) {
    return;
  }

  for (const monitorAlertConfig of monitorAlertsConfigurations) {
    const deDupId = `${monitor_tag}-${ts}-${monitorAlertConfig.id}`;

    const jobOptions: JobsOptions = {
      ...options,
      deduplication: {
        id: deDupId,
      },
    };
    await queue.add(
      jobNamePrefix + "_" + monitor_tag,
      {
        monitor_name: monitor.name,
        monitor_tag,
        monitor_settings: monitorSettings,
        monitor_alerts_configured: monitorAlertConfig,
        monitor_type: monitor.monitor_type,
        monitor_image: monitor.image,
        monitor_id: monitor.id,
        monitor_description: monitor.description,
        numerator: monitor.monitor_settings_json?.uptime_formula_numerator || GC.defaultNumeratorStr,
        denominator: monitor.monitor_settings_json?.uptime_formula_denominator || GC.defaultDenominatorStr,
        ts,
        status,
      },
      jobOptions,
    );
  }
};

//graceful shutdown
export const shutdown = async () => {
  if (worker) {
    await worker.close();
    worker = null;
  }
};

export default {
  push,
  shutdown,
};
