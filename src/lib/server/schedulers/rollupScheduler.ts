import { Queue, Worker, Job, type JobSchedulerTemplateOptions } from "bullmq";
import q from "../queues/q.js";
import db from "../db/db.js";
import { runWithOrg } from "../db/orgContext.js";
import { GetNowTimestampUTC } from "../tool.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import {
  advanceWatermark,
  backfillChunk,
  drainDirty,
  foldDays,
  getRegionBackfillStatus,
} from "../services/rollupEngine.js";

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
        `Rollups: recomputed ${drained.hours} dirty hour(s) -> ${drained.buckets5m} 5m, ${drained.buckets15m} 15m, ` +
          `${drained.buckets1h} 1h, ${drained.days} 1d`,
      );
    }

    // One watermark per region (F6d). Before this the scheduler passed
    // `MERGED_REGION_ID` here and the rollup tables held exactly one region
    // however many probes were reporting, so every per-region read fell back to
    // a raw scan over the full retention window.
    //
    // **Region 0 goes first and each region is isolated.** `getRollupRegionIds`
    // puts the merged verdict at the head of the list, and the try/catch means a
    // probe region whose samples are corrupt, or whose queries are slow, cannot
    // delay or fail the merged verdict the public page reads. That is the
    // property this loop exists to preserve; losing it would make adding a probe
    // a risk to the status page.
    for (const regionId of await db.getRollupRegionIds()) {
      try {
        const advanced = await advanceWatermark(regionId, nowTs);
        if (advanced.hours > 0) {
          console.log(
            `Rollups: region ${regionId} sealed ${advanced.hours} hour(s) -> ` +
              `${advanced.buckets5m} 5m, ${advanced.buckets15m} 15m, ${advanced.buckets1h} 1h, ${advanced.days} 1d`,
          );
        }
      } catch (error) {
        console.error(`Rollup forward pass failed for region ${regionId}:`, error);
      }
    }
  });
}

/**
 * The region this tick should backfill, or null when every region is done.
 *
 * **One region per tick, not one chunk per region (F6d).** The whole reason
 * backfill is its own rate-limited job is that it must not starve the monitor
 * checks of the five worker connections they share; fanning out per region would
 * multiply the work per tick by the number of probes and undo exactly that.
 * History arrives a little slower with several regions, which is the right
 * trade: it is history, and the forward pass is already current.
 *
 * Region 0 wins outright while it is incomplete. It is the verdict every read in
 * Kener goes through, so its history is worth more than any probe's, and the
 * read path stays on raw SQL until its `backfill_complete` flips.
 *
 * After that, the least-progressed region goes first. A region that has never
 * started sorts ahead of one part-way through, so a newly added probe is not
 * left behind a region that is nearly finished.
 */
async function pickBackfillRegion(): Promise<number | null> {
  const regionIds = await db.getRollupRegionIds();

  let candidate: { regionId: number; cursor: number } | null = null;
  for (const regionId of regionIds) {
    // Every grain, not just `1h`. Asking the hourly grain alone is what left the
    // quarter-hour grain unbuildable on an instance that had already finished
    // its backfill before that grain existed (KENER-124): `1h` said complete,
    // the region was skipped here, and nothing ever came back for the new grain.
    const status = await getRegionBackfillStatus(regionId);
    if (status.complete) continue;

    if (regionId === MERGED_REGION_ID) return regionId;

    // Never started sorts first: `backfill_cursor_ts` is null until the first
    // chunk lands, and treating that as "furthest behind" is what stops a new
    // probe queueing behind an almost-finished one forever.
    const cursor = status.cursor ?? Number.NEGATIVE_INFINITY;
    if (!candidate || cursor < candidate.cursor) candidate = { regionId, cursor };
  }

  return candidate?.regionId ?? null;
}

async function runBackfillPass(): Promise<void> {
  await forEachOrg("Rollup backfill", async () => {
    const nowTs = GetNowTimestampUTC();
    const regionId = await pickBackfillRegion();
    if (regionId === null) return;

    const progress = await backfillChunk(regionId, nowTs, 1);
    if (progress.chunksProcessed > 0) {
      // A fold catch-up reports no hours, because it recomputes none: it reads
      // one grain and writes the one above it. Counting the buckets it wrote is
      // the only way that pass shows up in the log as anything but silence.
      const { hours, buckets5m, buckets15m, buckets1h, days } = progress.summary;
      const work = hours > 0 ? `${hours} hours` : `${buckets5m + buckets15m + buckets1h + days} buckets folded`;
      console.log(
        `Rollups: region ${regionId} backfilled to ${new Date((progress.cursor ?? 0) * 1000).toISOString()} ` +
          `(${work})${progress.done ? " (COMPLETE)" : ""}`,
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

    // Per region (F6d), and asking each region for its own tags rather than
    // reusing region 0's: a probe that watches three of twenty monitors should
    // refold three days of three monitors, not of twenty.
    //
    // Unbounded across regions on purpose, unlike the backfill. This runs once a
    // day over three days, and every day it touches is one somebody may already
    // have been shown - so a region skipped here is a region whose daily bars
    // stay wrong until something else happens to dirty them.
    const days: Array<{ monitor_tag: string; region_id: number; day_start: number }> = [];
    let regionsWithSamples = 0;

    for (const regionId of await db.getRollupRegionIds()) {
      const tags = await db.getTagsWithSamples(regionId, from, nowTs);
      if (tags.length === 0) continue;
      regionsWithSamples++;
      for (const monitor_tag of tags) {
        for (let day = Math.floor(from / 86400) * 86400; day <= nowTs; day += 86400) {
          days.push({ monitor_tag, region_id: regionId, day_start: day });
        }
      }
    }
    if (days.length === 0) return;

    const written = await foldDays(days, nowTs);
    console.log(`Rollups: daily sweep refolded ${written} day bucket(s) across ${regionsWithSamples} region(s)`);
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
