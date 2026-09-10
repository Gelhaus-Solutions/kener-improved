import { Queue, Worker, Job, type JobSchedulerTemplateOptions } from "bullmq";
import q from "../queues/q.js";
import db from "../db/db.js";
import { runWithOrg } from "../db/orgContext.js";
import { GetNowTimestampUTC } from "../tool.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import { advanceWatermark, backfillChunk, drainDirty, foldDays } from "../services/rollupEngine.js";

/**
 * The scheduler that keeps the rollups current (F6b).
 *
 * **A queue of its own, not an extension of `dailyCleanup` and not
 * incremental-on-write.** Daily is the wrong cadence by a factor of 288.
 * On-write would put a read-modify-write on the hot path for every monitor every
 * minute and race with the retries `monitorResponseQueue` already performs, so
 * two deliveries of the same sample would double-count it - the exact failure
 * that "always recompute the whole bucket" exists to make impossible.
 *
 * Three schedules, each doing a different job:
 *
 *   **Every 5 minutes.** Drain the dirty set, then advance the watermark. Dirty
 *   first, deliberately: those are buckets that are already published and
 *   already wrong, while the watermark is only ever behind.
 *
 *   **Every 5 minutes, separately.** One backfill chunk, if history is still
 *   outstanding. Its own job so a slow backfill cannot delay the forward pass,
 *   and rate-limited so it cannot starve the monitor checks.
 *
 *   **Daily.** A safety sweep that refolds the last three days, in case a fold
 *   was lost to a crash between writing an hour and writing its day.
 */

const QUEUE_NAME = "rollupQueue";
const FORWARD_JOB = "rollupForward";
const BACKFILL_JOB = "rollupBackfill";
const SWEEP_JOB = "rollupSweep";

/**
 * Hours drained per pass.
 *
 * Five hundred is roughly a day of history for twenty monitors. Large enough
 * that an overlay rewrite clears in a pass or two, small enough that one pass
 * cannot hold the worker pool for minutes.
 */
const DIRTY_BATCH = 500;

let rollupQueue: Queue | null = null;
let worker: Worker | null = null;

const getQueue = () => {
  if (!rollupQueue) rollupQueue = q.createQueue(QUEUE_NAME);
  return rollupQueue;
};

/**
 * Runs `fn` once per organisation.
 *
 * Rollups are per-org because every table they touch is. Like `dailyCleanup`,
 * the job payload carries no `org_id`, so `createWorker` runs it under
 * `runAcrossOrgs` and the per-org loop supplies the scope. One org failing must
 * not stop the others: a monitor with corrupt samples in one tenant is not a
 * reason to stop computing every other tenant's bars.
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

async function runForwardPass(): Promise<void> {
  await forEachOrg("Rollup forward pass", async () => {
    const nowTs = GetNowTimestampUTC();

    // Dirty first. These are buckets somebody is already being shown and that
    // are already wrong; the watermark is merely behind.
    const drained = await drainDirty(DIRTY_BATCH, nowTs);
    if (drained.hours > 0) {
      console.log(
        `Rollups: recomputed ${drained.hours} dirty hour(s) -> ${drained.buckets5m} 5m, ${drained.buckets1h} 1h, ${drained.days} 1d`,
      );
    }

    const advanced = await advanceWatermark(MERGED_REGION_ID, nowTs);
    if (advanced.hours > 0) {
      console.log(
        `Rollups: sealed ${advanced.hours} hour(s) -> ${advanced.buckets5m} 5m, ${advanced.buckets1h} 1h, ${advanced.days} 1d`,
      );
    }
  });
}

async function runBackfillPass(): Promise<void> {
  await forEachOrg("Rollup backfill", async () => {
    const nowTs = GetNowTimestampUTC();
    const progress = await backfillChunk(MERGED_REGION_ID, nowTs, 1);
    if (progress.chunksProcessed > 0) {
      console.log(
        `Rollups: backfilled to ${new Date((progress.cursor ?? 0) * 1000).toISOString()} ` +
          `(${progress.summary.hours} hours)${progress.done ? " — COMPLETE" : ""}`,
      );
    }
  });
}

/**
 * Refolds the last three days from their hourly rows.
 *
 * Belt and braces. `recomputeHours` already refolds the day it touched, so this
 * finds nothing in the ordinary case - but the fold is a second transaction
 * after the hourly write, and a process killed between the two would leave a day
 * that never catches up on its own. Three days is enough to cover a weekend of
 * being dead.
 */
async function runDailySweep(): Promise<void> {
  await forEachOrg("Rollup daily sweep", async () => {
    const nowTs = GetNowTimestampUTC();
    const from = nowTs - 3 * 86400;
    const tags = await db.getTagsWithSamples(MERGED_REGION_ID, from, nowTs);
    if (tags.length === 0) return;

    const days: Array<{ monitor_tag: string; region_id: number; day_start: number }> = [];
    for (const monitor_tag of tags) {
      for (let day = Math.floor(from / 86400) * 86400; day <= nowTs; day += 86400) {
        days.push({ monitor_tag, region_id: MERGED_REGION_ID, day_start: day });
      }
    }
    const written = await foldDays(days, nowTs);
    console.log(`Rollups: daily sweep refolded ${written} day bucket(s) across ${tags.length} monitor(s)`);
  });
}

const addWorker = () => {
  if (worker) return worker;

  worker = q.createWorker(
    getQueue(),
    async (job: Job) => {
      // Exact names, supplied by the templates below. A `startsWith` here would
      // be one shared prefix away from silently routing every job to one branch.
      if (job.name === BACKFILL_JOB) return await runBackfillPass();
      if (job.name === SWEEP_JOB) return await runDailySweep();
      return await runForwardPass();
    },
    {
      // **One at a time.** The worker connection pool is five connections by
      // default and the monitor checks share it. A rollup pass that ran three
      // wide would take most of it, and the thing that would break is the
      // checking the product exists to do.
      concurrency: 1,
      // And no more than a few passes a minute even if jobs pile up, so a
      // backlog drains steadily instead of in one burst.
      limiter: { max: 4, duration: 60_000 },
    },
  );

  worker.on("failed", (_job: Job | undefined, error: Error) => {
    console.error("Rollup scheduler failed:", error);
  });

  return worker;
};

export const start = async (options?: JobSchedulerTemplateOptions) => {
  const opts: JobSchedulerTemplateOptions = { ...(options ?? {}) };
  opts.removeOnComplete = { age: 3600, count: 50 };
  // **Set explicitly.** `q.ts` defaults `removeOnFail` to `false`, which keeps
  // every failed job forever; a rollup job that fails every five minutes would
  // fill Redis quietly.
  opts.removeOnFail = { age: 24 * 3600, count: 200 };

  const queue = getQueue();
  addWorker();

  // `name` is passed explicitly: without it the job takes the scheduler id, and
  // the worker's dispatch above would be matching on whatever BullMQ happened to
  // choose rather than on something this file controls.
  await queue.upsertJobScheduler(`${FORWARD_JOB}_every_5m`, { pattern: "*/5 * * * *" }, { name: FORWARD_JOB, opts });
  await queue.upsertJobScheduler(`${BACKFILL_JOB}_every_5m`, { pattern: "*/5 * * * *" }, { name: BACKFILL_JOB, opts });
  // 00:20 rather than midnight, so it does not collide with `dailyCleanup`
  // deleting from the very table it is about to read.
  await queue.upsertJobScheduler(`${SWEEP_JOB}_daily`, { pattern: "20 0 * * *" }, { name: SWEEP_JOB, opts });

  console.log("Rollup scheduler started (forward + backfill every 5 minutes, sweep at 00:20 UTC)");
};

export const shutdown = async () => {
  if (worker) {
    await worker.close();
    worker = null;
  }
};

export default { start, shutdown, runForwardPass, runBackfillPass, runDailySweep };
