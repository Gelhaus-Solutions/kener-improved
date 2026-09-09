import type { MonitoringResult } from "../types/monitor.js";
import { Queue, Worker, Job, type JobsOptions } from "bullmq";
import q from "./q.js";
import { InsertMonitoringData } from "../controllers/controller.js";
import { SetLastMonitoringValue, GetLastMonitoringValue } from "../cache/setGet.js";
import alertingQueue from "./alertingQueue.js";
import type { MonitoringData } from "../types/db.js";
import db from "../db/db.js";
import { emit } from "../events/emit.js";
import { currentOrgId } from "../events/eventContext.js";
import { MERGED_REGION_ID } from "../db/regions.js";
let monitorResponseQueue: Queue | null = null;
let worker: Worker | null = null;
const queueName = "monitorResponseQueue";
const jobNamePrefix = "monitorResponseJob";

interface JobData {
  status: string;
  latency: number;
  type: string;
  monitorTag: string;
  ts: number;
  error_message?: string | null;
  raw_status?: string | null;
}

const getQueue = () => {
  if (!monitorResponseQueue) {
    monitorResponseQueue = q.createQueue(queueName);
  }
  return monitorResponseQueue;
};

const addWorker = () => {
  if (worker) return worker;

  worker = q.createWorker(getQueue(), async (job: Job): Promise<MonitoringData | null> => {
    const { monitorTag, ts, status, latency, type, error_message, raw_status } = job.data as JobData;

    // Read before the write, and before the cache is overwritten below: this is
    // the only cheap way to know whether this sample is a *transition*. Falling
    // back to the database keeps a cold cache from inventing a status change out
    // of the first sample after a restart.
    const previous = await GetLastMonitoringValue(monitorTag, () => db.getLatestMonitoringData(monitorTag));

    const dbRes = await db.withTransaction(async () => {
      const inserted = await InsertMonitoringData({
        monitor_tag: monitorTag,
        timestamp: ts,
        status: status,
        latency: latency,
        type: type,
        error_message: error_message,
        raw_status: raw_status,
      });

      if (!inserted) return null;

      // Only on an actual transition. A status page checks hundreds of monitors
      // a minute and almost every sample says "still UP"; emitting per sample
      // would put hundreds of thousands of rows a day into the outbox to report
      // that nothing happened.
      //
      // `previous == null` is a monitor's first ever sample, which is a start,
      // not a change, and nobody wants to be paged for it.
      if (previous && previous.status !== status) {
        await emit({
          org_id: currentOrgId(),
          type: "monitor.status_changed",
          aggregate_id: monitorTag,
          // One transition per monitor per sample timestamp. This queue already
          // deduplicates on `${tag}-${region}-${ts}`, and a redelivered job must
          // not report the same flip twice.
          idempotency_key: `monitor.status_changed:${monitorTag}:${ts}`,
          occurred_at: ts,
          payload: {
            monitor_tag: monitorTag,
            status,
            previous_status: previous.status,
            latency,
            timestamp: ts,
            error_message: error_message ?? null,
          },
          diff: { before: { status: previous.status }, after: { status } },
        });
      }

      return inserted;
    });

    if (!dbRes) {
      console.error("Failed to insert monitoring data for monitorTag:", monitorTag, "timestamp:", ts);
      throw new Error("Failed to insert monitoring data");
    }

    await SetLastMonitoringValue(monitorTag, {
      monitor_tag: monitorTag,
      timestamp: ts,
      region_id: MERGED_REGION_ID,
      status: status,
      latency: latency,
      type: type,
    });
    alertingQueue.push(monitorTag, ts, status);

    return dbRes;
  });

  worker.on("completed", (job: Job, returnvalue: any) => {
    // const { monitorTag, ts, status, latency, type } = job.data as JobData;
    // console.log(`💾 Store: ${monitorTag} @ ${new Date(ts * 1000).toISOString()}`);
  });

  return worker;
};

export const push = async (monitorTag: string, ts: number, result: MonitoringResult, options?: JobsOptions) => {
  // The region belongs in the deduplication id for the same reason it belongs in
  // the primary key: two regions reporting one monitor's minute are two distinct
  // samples. Keyed on `${tag}-${ts}` alone, BullMQ would drop the second as a
  // duplicate of the first and the row would never be written at all — a quieter
  // failure than the key collision, because nothing would even reach the
  // database to be overwritten.
  const deDupId = `${monitorTag}-${MERGED_REGION_ID}-${ts}`;
  if (!options) {
    options = {};
  }
  if (!options.deduplication) {
    options.deduplication = {
      id: deDupId,
    };
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
  await queue.add(
    jobNamePrefix + "_" + monitorTag,
    {
      monitorTag,
      ts,
      ...result,
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
