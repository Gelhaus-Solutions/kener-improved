import { Queue, Worker, Job, type JobSchedulerTemplateOptions } from "bullmq";
import q from "../queues/q.js";
import db from "../db/db.js";
import { runWithOrg } from "../db/orgContext.js";
import { GetNowTimestampUTC } from "../tool.js";
import alertingQueue from "../queues/alertingQueue.js";

/**
 * Drives certificate expiry alerting (B7).
 *
 * **Daily, not per sample, and that is the design rather than a compromise.**
 * STATUS and LATENCY alerts are evaluated from each monitoring sample, because
 * that is when a monitor's condition can have changed. A certificate's condition
 * does not: it changes when somebody reissues it, about once a quarter. Running
 * this on the sample clock would mean a TLS handshake per monitor per minute -
 * hundreds of thousands of pointless handshakes a day, mostly against other
 * people's servers, to re-read a date.
 *
 * **03:17, not midnight.** Every scheduled thing in every product runs at
 * midnight, so a certificate check there competes with backups, rotations and
 * every other daily job, and a slow handshake is the first thing to suffer. The
 * odd minute also makes this instance's traffic distinguishable in somebody
 * else's logs, which is a courtesy when the job is repeatedly connecting to
 * hosts it does not own.
 *
 * A missed tick costs a day of staleness on a value measured in weeks, so there
 * is no backfill and no sweep: the next tick is soon enough.
 */

const QUEUE_NAME = "certificateQueue";
const EVALUATE_JOB = "certificateEvaluate";

let certQueue: Queue | null = null;
let worker: Worker | null = null;

const getQueue = () => {
  if (!certQueue) certQueue = q.createQueue(QUEUE_NAME);
  return certQueue;
};

/**
 * Runs `fn` once per organisation.
 *
 * Same shape and same reason as `slaScheduler.forEachOrg`: the job payload
 * carries no `org_id`, so the per-org loop supplies the scope, and one org
 * failing must not stop the others.
 */
async function forEachOrg(label: string, fn: () => Promise<void>): Promise<void> {
  const orgIds = await db.getActiveOrgIds();
  for (const orgId of orgIds) {
    try {
      await runWithOrg(orgId, fn);
    } catch (error) {
      console.error(`${label} failed for org ${orgId}:`, error);
    }
  }
}

export async function runCertificatePass(): Promise<void> {
  await forEachOrg("Certificate evaluation", async () => {
    await alertingQueue.pushCertExpiry(GetNowTimestampUTC());
  });
}

const addWorker = () => {
  if (worker) return worker;

  worker = q.createWorker(getQueue(), async (_job: Job) => await runCertificatePass(), {
    // One at a time. This shares the worker connection pool with the monitor
    // checks, and the checking is what must not be starved.
    concurrency: 1,
    limiter: { max: 4, duration: 60_000 },
  });

  worker.on("failed", (_job: Job | undefined, error: Error) => {
    console.error("Certificate scheduler failed:", error);
  });

  return worker;
};

export const start = async (options?: JobSchedulerTemplateOptions) => {
  const opts: JobSchedulerTemplateOptions = { ...(options ?? {}) };
  opts.removeOnComplete = { age: 3600, count: 50 };
  // Set explicitly: `q.ts` defaults `removeOnFail` to `false`, which would keep
  // every failed job forever and fill Redis quietly.
  opts.removeOnFail = { age: 24 * 3600, count: 200 };

  const queue = getQueue();
  addWorker();

  await queue.upsertJobScheduler(`${EVALUATE_JOB}_daily`, { pattern: "17 3 * * *" }, { name: EVALUATE_JOB, opts });

  console.log("Certificate scheduler started (expiry check daily at 03:17)");
};

export const shutdown = async () => {
  if (worker) {
    await worker.close();
    worker = null;
  }
};

export default { start, shutdown, runCertificatePass };
