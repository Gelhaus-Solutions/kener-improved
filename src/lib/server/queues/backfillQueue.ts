import { Queue, Worker } from "bullmq";
import q from "./q.js";
import db from "../db/db.js";
import GC from "../../global-constants.js";
import { monitorImpactFor, isComponentImpact, type ComponentImpact } from "../incidents/impact.js";

/**
 * C7: writes a backfilled incident's `monitoring_data` overlay, off the request.
 *
 * **Why this is a job and not part of the request.** One row per monitor per
 * minute: a three-day outage across four components is ~17,000 rows, and the cap
 * allows up to 100,000. That is not a thing to make an operator's browser wait
 * for, and it is emphatically not a thing to do inside the transaction that
 * created the incident - a long write there holds locks that every live check
 * coming in behind it needs.
 *
 * **Why the overlay is separate from the incident at all.** The incident and its
 * comments are the *communication*; `monitoring_data` is the *timeline*. Nothing
 * derives one from the other: the bars, the uptime percentages and the SLA
 * numbers all read `monitoring_data` and know nothing about incidents. An
 * imported incident with no overlay is a story with no evidence behind it, which
 * is exactly the state C7 exists to fix.
 *
 * The job is idempotent. `updateMonitoringData` upserts on
 * `(monitor_tag, timestamp)`, so a retried job rewrites the same window to the
 * same values - which matters, because BullMQ retries three times by default and
 * a partial first attempt is the ordinary case for a job this size.
 */

let backfillQueue: Queue | null = null;
let worker: Worker | null = null;
const queueName = "backfillQueue";

export interface BackfillOverlayJob {
  incident_id: number;
  start: number;
  end: number;
  components: Array<{ monitor_tag: string; component_impact: string }>;
  org_id?: number;
}

/**
 * How many minutes one job writes before yielding.
 *
 * `updateMonitoringData` already batches its inserts at 500 rows inside one
 * transaction per call. Slicing the window on top of that keeps any single
 * transaction short, which is the property that matters on a live instance: a
 * ninety-day window written as one statement would hold a write lock on
 * `monitoring_data` long enough for the minute checks to pile up behind it.
 */
const SLICE_MINUTES = 1440;

const getQueue = () => {
  if (!backfillQueue) backfillQueue = q.createQueue(queueName);
  return backfillQueue;
};

async function push(job: BackfillOverlayJob): Promise<void> {
  await getQueue().add(
    `backfill-${job.incident_id}`,
    job,
    // Keyed on the incident, so an importer that retries a request cannot
    // enqueue the same window twice. The write is idempotent anyway; this saves
    // doing it twice rather than making it safe.
    { jobId: `backfill-overlay-${job.incident_id}` },
  );
}

/**
 * Writes the overlay for one incident.
 *
 * Exported so the tests and the verification drivers can run it without Redis.
 * The worker below is a thin wrapper around it.
 */
export async function writeBackfillOverlay(job: BackfillOverlayJob): Promise<number> {
  let written = 0;

  for (const component of job.components) {
    if (!isComponentImpact(component.component_impact)) continue;
    const status = monitorImpactFor(component.component_impact as ComponentImpact);
    // OPERATIONAL projects to no overlay at all - writing UP would assert health
    // the monitors never reported. See incidents/impact.ts.
    if (status === null) continue;

    for (let sliceStart = job.start; sliceStart <= job.end; sliceStart += SLICE_MINUTES * 60) {
      const sliceEnd = Math.min(job.end, sliceStart + SLICE_MINUTES * 60 - 60);
      // The same call the admin "update monitoring data" action makes, with
      // `type = INCIDENT`, so a backfilled window is indistinguishable from a
      // window an operator marked by hand - and is treated identically by the
      // confirmation-threshold freeze gate, which reads exactly this type.
      await db.updateMonitoringData(component.monitor_tag, sliceStart, sliceEnd, status, GC.INCIDENT, 0, 0);
      written += Math.floor((sliceEnd - sliceStart) / 60) + 1;
    }
  }

  return written;
}

async function start(): Promise<void> {
  if (worker) return;
  worker = q.createWorker<BackfillOverlayJob, void>(
    getQueue(),
    async (job) => {
      const written = await writeBackfillOverlay(job.data);
      console.log(`backfill: wrote ${written} timeline rows for incident ${job.data.incident_id}`);
    },
    // One at a time. The whole point is to keep this off the hot path; running
    // several large overlay writes concurrently would put the load back.
    { concurrency: 1 },
  );
}

async function stop(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (backfillQueue) {
    await backfillQueue.close();
    backfillQueue = null;
  }
}

export default { push, start, stop, writeBackfillOverlay };
