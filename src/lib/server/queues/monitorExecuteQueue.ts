import type { MonitoringResult, MonitoringResultTS } from "../types/monitor.js";
import { Queue, Worker, Job, type JobsOptions } from "bullmq";
import q from "./q.js";
import { applyLatencyEscalation } from "../services/latencyThreshold.js";
import type { MonitorRecordTyped } from "../types/db.js";
import Service, { type MonitorWithType } from "../services/service.js";
import { GetMinuteStartNowTimestampUTC } from "../tool.js";
import db from "../db/db.js";
import monitorResponseQueue from "./monitorResponseQueue";
import GC from "../../global-constants.js";
import { resolveConfirmedStatus } from "../services/confirmationThreshold.js";
import { planProbeExecution, runOnProbe, dispatchSample } from "../probes/dispatch.js";
import { mergeObservations, LOCAL_REGION_ID, type Observation } from "../probes/merge.js";

let monitorExecuteQueue: Queue | null = null;
let worker: Worker | null = null;
const queueName = "monitorExecuteQueue";
const jobNamePrefix = "monitorExecuteJob";

interface JobData {
  monitor: MonitorRecordTyped;
  ts: number;
}

const getQueue = () => {
  if (!monitorExecuteQueue) {
    monitorExecuteQueue = q.createQueue(queueName);
  }
  return monitorExecuteQueue;
};

async function manualMaintenance(
  monitor: MonitorRecordTyped,
  ts?: number,
): Promise<{ [timestamp: number]: MonitoringResult }> {
  // Key by the job's `ts` (already a minute-start) so the overlay aligns with the realtime/default
  // rows and the freeze gate; fall back to "now" only when called without a ts.
  let startTs = ts !== undefined ? ts : GetMinuteStartNowTimestampUTC();
  let maintenanceArr = await db.getMaintenancesByMonitorTagRealtime(monitor.tag, startTs);

  let impact = "";
  if (maintenanceArr.length == 0) {
    return {};
  }

  for (let i = 0; i < maintenanceArr.length; i++) {
    const element = maintenanceArr[i];

    if (element.monitor_impact === GC.MAINTENANCE) {
      impact = GC.MAINTENANCE;
      break;
    }
    if (element.monitor_impact === GC.DOWN) {
      impact = GC.DOWN;
      break;
    }
    if (element.monitor_impact === GC.DEGRADED) {
      impact = GC.DEGRADED;
    }
  }

  if (impact === "") {
    return {};
  }

  let manualData = {
    [startTs]: {
      status: impact,
      latency: 0,
      type: GC.MAINTENANCE,
      error_message: "Status set by manual maintenance",
    },
  };

  return manualData;
}

async function manualIncident(
  monitor: MonitorRecordTyped,
  ts?: number,
): Promise<{ [timestamp: number]: MonitoringResult }> {
  // Key by the job's `ts` (already a minute-start) so the overlay aligns with the realtime/default
  // rows and the freeze gate; fall back to "now" only when called without a ts.
  let startTs = ts !== undefined ? ts : GetMinuteStartNowTimestampUTC();
  let incidentArr = await db.getIncidentsByMonitorTagRealtime(monitor.tag, startTs);

  let impact = "";
  if (incidentArr.length == 0) {
    return {};
  }

  for (let i = 0; i < incidentArr.length; i++) {
    const element = incidentArr[i];

    if (element.monitor_impact === GC.MAINTENANCE) {
      impact = GC.MAINTENANCE;
      break;
    }
    if (element.monitor_impact === GC.DOWN) {
      impact = GC.DOWN;
      break;
    }
    if (element.monitor_impact === GC.DEGRADED) {
      impact = GC.DEGRADED;
    }
  }

  if (impact === "") {
    return {};
  }

  let manualData = {
    [startTs]: {
      status: impact,
      latency: 0,
      type: GC.INCIDENT,
      error_message: "Status set by manual incident",
    },
  };

  return manualData;
}
const addWorker = () => {
  if (worker) return worker;

  worker = q.createWorker(getQueue(), async (job: Job): Promise<MonitoringResultTS> => {
    const { monitor, ts } = job.data as JobData;
    const serviceClient = new Service(monitor as MonitorWithType);

    /**
     * B1c/B1d. Where this check runs, and how several answers become one.
     *
     * The plan is local-only for every monitor nobody has assigned to a probe
     * and for every type that can never be remote, which is almost all of them,
     * so the ordinary path below is unchanged and costs one map lookup.
     *
     * With probes in play the shape is: dispatch the display-only sources and
     * forget them, await the voting ones in parallel, run locally unless an
     * agent holds the local slot, then merge. `mergeObservations` produces the
     * row that is written at region 0, and every source's own answer is written
     * at its own region so the breakdown and the rollups have something to read.
     *
     * **Local fallback survives unchanged.** `runOnProbe` resolves to null for
     * every unhappy ending - rejected, timed out, disconnected mid-check - and if
     * the agent holding the local slot produces nothing, the server checks
     * locally in the same tick. For a status page, checking the thing yourself is
     * the safest thing to do when the fleet is unreliable.
     */
    const probePlan = await planProbeExecution(monitor);
    for (const sample of probePlan.displayOnly) {
      dispatchSample(sample.connection, monitor, ts);
    }

    // In parallel: N probes each bounded by the monitor's own timeout plus
    // slack, so the tick costs one timeout rather than N of them.
    const probeAnswers = await Promise.all(
      probePlan.voting.map(async (source) => ({
        regionId: source.regionId,
        result: await runOnProbe(source.connection, monitor, ts),
      })),
    );

    const observations: Observation[] = [];
    let localAnswered = false;
    for (const answer of probeAnswers) {
      if (!answer.result) continue;
      if (answer.regionId === LOCAL_REGION_ID) localAnswered = true;
      observations.push({ regionId: answer.regionId, result: answer.result });
    }

    // The server checks it itself unless an agent is standing in for it and
    // actually answered. `OFF` is the one case where nobody checks locally at
    // all, which is what it is for: a monitor only reachable from a probe.
    const localMode = probePlan.config.sources.get(LOCAL_REGION_ID)?.mode ?? "VOTE";
    const localIsCovered = probePlan.localSlot !== null && localAnswered;
    if (!localIsCovered && localMode !== "OFF") {
      const localResult = await serviceClient.execute(ts);
      if (localResult) observations.push({ regionId: LOCAL_REGION_ID, result: localResult });
    }

    /**
     * The verdict.
     *
     * A single observation merges to itself under every policy, so an install
     * with no probes gets exactly what `serviceClient.execute` returned, with no
     * behaviour change and no extra row. `mergeObservations` returns null only
     * when nothing could decide, and then there is nothing to publish for this
     * minute - which is what happened before B1d when a probe went silent and
     * the local check was skipped.
     */
    let lastKnownStatus: string | undefined;
    if (probePlan.config.policy === "QUORUM_DOWN" && observations.length > 0) {
      // Only QUORUM_DOWN reads it, so only QUORUM_DOWN pays for the query.
      try {
        lastKnownStatus = (await db.getLastKnownStatus(monitor.tag))?.status ?? undefined;
      } catch (error) {
        // A held status that cannot find what it is holding falls to UP inside
        // the merge, which is the conservative reading: the quorum explicitly
        // refused to declare DOWN.
        console.error(`Last known status lookup failed for ${monitor.tag}:`, error);
      }
    }

    const exeResult =
      observations.length > 1 || probePlan.localSlot !== null || probePlan.displayOnly.length > 0
        ? mergeObservations(observations, probePlan.config, lastKnownStatus)
        : (observations[0]?.result ?? null);

    /**
     * Each source's own row, at its own region.
     *
     * Written only when the monitor is actually probed. An unprobed monitor has
     * one observation and one row at region 0, exactly as before - which is the
     * whole reason this is conditional: `monitoring_data` is the largest table in
     * the schema and doubling its write volume for every install that never uses
     * a probe would be a real cost for no benefit.
     *
     * `monitorResponseQueue` already gates everything except the row itself on
     * the region (B1b), so a source row drives no cache, no alert and no status
     * change. Only region 0 does.
     */
    if (probePlan.localSlot !== null || probePlan.voting.length > 0 || probePlan.displayOnly.length > 0) {
      for (const observation of observations) {
        monitorResponseQueue.push(monitor.tag, ts, observation.result, observation.regionId);
      }
    }

    // B5. Before `raw_status` is assigned below, deliberately: escalating the
    // *observed* status is what lets the confirmation threshold damp a latency
    // flip like any other, leaves the overlay merge untouched, and keeps the
    // freeze gate working. See services/latencyThreshold.ts.
    if (exeResult) {
      await applyLatencyEscalation(monitor.tag, monitor.monitor_settings_json, exeResult, ts);
    }

    // Fetch overlays AFTER the check runs so a maintenance/incident that starts mid-check is still
    // detected, and key them by the job's `ts` so the freeze gate (incidentData[ts]) is
    // timestamp-safe even if the job is delayed or retried (#756).
    let incidentData: MonitoringResultTS = await manualIncident(monitor, ts);
    let maintenanceData: MonitoringResultTS = await manualMaintenance(monitor, ts);

    let realtimeData: MonitoringResultTS = {};
    if (exeResult) {
      realtimeData[ts] = exeResult;
      // Always record what the check actually observed (forensics + grace counting).
      realtimeData[ts].raw_status = exeResult.status;

      // Confirmation Threshold damping (#712): scheduled checks only.
      const threshold = Number(monitor.confirmation_threshold ?? 1);
      const isScheduledCheck = ([GC.REALTIME, GC.TIMEOUT, GC.ERROR] as string[]).includes(exeResult.type);
      // Confirmation Threshold freezes while an incident/maintenance overlay is active for this
      // minute: the overlay wins display and the count must neither advance nor backfill (#756).
      const overlayActive = incidentData[ts] !== undefined || maintenanceData[ts] !== undefined;
      if (threshold > 1 && isScheduledCheck && !overlayActive) {
        const resolved = await resolveConfirmedStatus({
          monitor_tag: monitor.tag,
          ts,
          rawStatus: exeResult.status,
          threshold,
        });
        realtimeData[ts].status = resolved.status;
        if (resolved.pendingHold) {
          // Hold the confirmed side for display, but PRESERVE the observed latency and error text —
          // no diagnostic info is discarded. Tag the row to record that the status is being held
          // during the grace period; on confirmation the backfill appends the confirmation note (#756).
          const observedError = realtimeData[ts].error_message;
          realtimeData[ts].error_message = observedError
            ? `${observedError} | Status held during grace period`
            : "Status held during grace period";
        }
      }
    }
    let defaultData: MonitoringResultTS = {};
    let mergedData: MonitoringResultTS = {};

    if (monitor.default_status !== undefined && monitor.default_status !== null) {
      if (([GC.UP, GC.DOWN, GC.DEGRADED] as string[]).indexOf(monitor.default_status) !== -1) {
        defaultData[ts] = {
          status: monitor.default_status,
          latency: 0,
          type: GC.DEFAULT_STATUS,
        };
        if (monitor.default_status !== GC.UP) {
          defaultData[ts].error_message = "Default status applied";
        }
      }
    }

    // Merge data: later entries override earlier ones for all fields except error_message
    // Special-case: if realtime returns NO_DATA but a default status exists, prefer default status.
    const defaultStatus = defaultData[ts]?.status;
    const realtimeStatus = realtimeData[ts]?.status;
    let realtimeDataForMerge = realtimeData;
    if (defaultStatus && realtimeStatus === GC.NO_DATA) {
      // Apply the preference *before* merging so incident/maintenance can still override later.
      // Also avoid carrying over realtime NO_DATA error_message.
      realtimeDataForMerge = { ...realtimeData };
      realtimeDataForMerge[ts] = {
        ...realtimeDataForMerge[ts],
        status: defaultStatus,
        type: GC.DEFAULT_STATUS,
      };
      delete realtimeDataForMerge[ts].error_message;
    }

    mergedData = { ...defaultData, ...realtimeDataForMerge, ...incidentData, ...maintenanceData };

    // Preserve error_message with cascading priority:
    // default → realtime → incident → maintenance
    // Each level only overrides if it has its own error_message
    for (const timestamp in mergedData) {
      const ts = parseInt(timestamp);
      let errorMessage: string | undefined = defaultData[ts]?.error_message;
      if (realtimeData[ts]?.error_message) {
        errorMessage = realtimeData[ts].error_message;
      }
      if (incidentData[ts]?.error_message) {
        errorMessage = incidentData[ts].error_message;
      }
      if (maintenanceData[ts]?.error_message) {
        errorMessage = maintenanceData[ts].error_message;
      }
      if (errorMessage) {
        mergedData[ts].error_message = errorMessage;
      }
    }

    // Preserve latency from realtime monitoring
    // Incident/maintenance override status but should keep the actual latency from monitoring
    for (const timestamp in mergedData) {
      const ts = parseInt(timestamp);
      if (realtimeData[ts]?.latency !== undefined && realtimeData[ts].latency > 0) {
        mergedData[ts].latency = realtimeData[ts].latency;
      }
    }

    // Preserve raw_status from realtime monitoring (overlays replace the merged object wholesale,
    // so re-attach the observed value the resolver recorded).
    for (const timestamp in mergedData) {
      const ts = parseInt(timestamp);
      if (realtimeData[ts]?.raw_status !== undefined) {
        mergedData[ts].raw_status = realtimeData[ts].raw_status;
      }
    }

    for (const timestamp in mergedData) {
      monitorResponseQueue.push(monitor.tag, parseInt(timestamp), mergedData[timestamp]);
    }

    return mergedData;
  });

  worker.on("completed", (job: Job, returnvalue: any) => {
    // const { monitor, ts } = job.data as JobData;
    // console.log(`📀 Execute: ${monitor.tag} @ ${new Date(ts * 1000).toISOString()}`);
  });

  return worker;
};

export const push = async (monitor: MonitorRecordTyped, ts: number, options?: JobsOptions) => {
  const deDupId = `${monitor.tag}-${ts}`;
  if (!options) {
    options = {};
  }
  if (!options.deduplication) {
    options.deduplication = {
      id: deDupId,
    };
  }
  options.removeOnComplete = {
    age: 3600, // keep up to 1 hour
    count: 1000, // keep up to 1000 jobs
  };
  options.removeOnFail = {
    age: 24 * 3600, // keep up to 24 hours
  };
  const queue = getQueue();
  addWorker();
  await queue.add(
    jobNamePrefix + "_" + monitor.tag,
    {
      monitor,
      ts,
    },
    options,
  );
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
