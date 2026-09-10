import { Queue, Worker, Job, type JobSchedulerTemplateOptions } from "bullmq";
import q from "../queues/q.js";
import db from "../db/db.js";
import { runWithOrg } from "../db/orgContext.js";
import { GetNowTimestampUTC } from "../tool.js";
import { evaluateAllTargets } from "../services/slaEvaluator.js";
import alertingQueue from "../queues/alertingQueue.js";

/**
 * Recomputes every active SLO target's evaluation (F1a).
 *
 * **A scheduler rather than computing on read**, because the alternative is a
 * dashboard that runs a month-wide aggregate per target on every page load, and
 * burn-rate alerting that would have to run the same four extra window reads
 * every time the alerting queue ticks. Precomputed, the dashboard and the alert
 * rule are both a single-row read.
 *
 * **Every five minutes**, matching `rollupScheduler`'s forward pass. There is no
 * point being fresher than the data: the hourly watermark advances on that same
 * cadence, and the live tail this reads on top of it is at most one pass old.
 *
 * One schedule and one job. Unlike the rollups there is no backfill and no
 * sweep - an evaluation holds nothing that cannot be recomputed from the rollups
 * and the target, so a missed tick costs five minutes of staleness and nothing
 * else.
 */

const QUEUE_NAME = "slaQueue";
const EVALUATE_JOB = "slaEvaluate";

let slaQueue: Queue | null = null;
let worker: Worker | null = null;

const getQueue = () => {
  if (!slaQueue) slaQueue = q.createQueue(QUEUE_NAME);
  return slaQueue;
};

/**
 * Runs `fn` once per organisation.
 *
 * Same shape and same reason as `rollupScheduler.forEachOrg`: the job payload
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

async function runEvaluatePass(): Promise<void> {
  await forEachOrg("SLO evaluation", async () => {
    const nowTs = GetNowTimestampUTC();
    const { evaluated } = await evaluateAllTargets(nowTs);
    if (evaluated > 0) console.log(`SLO: evaluated ${evaluated} target(s)`);

    // F1b. Burn-rate alerting is pushed here, straight after the evaluations it
    // reads, rather than from `push()` when a sample lands: an SLO's burn rate
    // changes when it is recomputed, and a page- or category-scoped target has
    // no single monitor whose sample could stand for it.
    //
    // Inside the same org scope, and after the write: the jobs read
    // `sla_evaluations`, so pushing before would judge the previous tick.
    await alertingQueue.pushSloBurnRate(nowTs);
  });
}

const addWorker = () => {
  if (worker) return worker;

  worker = q.createWorker(getQueue(), async (_job: Job) => await runEvaluatePass(), {
    // One at a time, for the same reason the rollup worker is: this shares the
    // five-connection worker pool with the monitor checks, and the checking is
    // what must not be starved.
    concurrency: 1,
    limiter: { max: 4, duration: 60_000 },
  });

  worker.on("failed", (_job: Job | undefined, error: Error) => {
    console.error("SLO scheduler failed:", error);
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

  await queue.upsertJobScheduler(`${EVALUATE_JOB}_every_5m`, { pattern: "*/5 * * * *" }, { name: EVALUATE_JOB, opts });

  console.log("SLO scheduler started (evaluation every 5 minutes)");
};

export const shutdown = async () => {
  if (worker) {
    await worker.close();
    worker = null;
  }
};

export default { start, shutdown, runEvaluatePass };
