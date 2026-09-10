import { Queue, Worker, Job, type JobSchedulerTemplateOptions } from "bullmq";
import q from "../queues/q.js";
import db from "../db/db.js";
import { runWithOrg } from "../db/orgContext.js";
import { GetNowTimestampUTC } from "../tool.js";
import reportQueue from "../queues/reportQueue.js";
import { deleteArtifact } from "../reports/artifactStore.js";

/**
 * Enqueues due report schedules, hourly (F4).
 *
 * **Hourly, not per-minute.** The finest thing a schedule can express is "at
 * 09:00 on the 1st", and delivering that at 09:00 rather than 09:00:07 is worth
 * nothing to anybody. An hourly sweep also means a restart costs at most an hour
 * of lateness rather than a missed send.
 *
 * The tick itself does no rendering. It finds due rows, pushes one job each and
 * returns; `reportQueue` does the work. See that file for why.
 *
 * **The sweep of expired artifacts lives here too**, on the same tick. An
 * expired download link that still resolves to a file on disk is the security
 * half of "the link expires", and a tidy `report_artifacts` table is the other
 * half. Doing it here rather than in `dailyCleanup` keeps F4's two halves in one
 * file; it is idempotent and cheap enough to run every hour.
 */

const QUEUE_NAME = "reportSchedulerQueue";
const TICK_JOB = "reportSchedulerTick";

let schedulerQueue: Queue | null = null;
let worker: Worker | null = null;

const getQueue = () => {
  if (!schedulerQueue) schedulerQueue = q.createQueue(QUEUE_NAME);
  return schedulerQueue;
};

/**
 * Pushes every schedule that is due.
 *
 * `getDueReportSchedules` reads across orgs, because an hourly tick has no org
 * of its own; each job then carries the row's `org_id` and the worker enters it
 * before touching anything.
 */
export async function runTick(): Promise<{ queued: number }> {
  const nowTs = GetNowTimestampUTC();
  const due = await db.getDueReportSchedules(nowTs);
  let queued = 0;

  for (const schedule of due) {
    try {
      await reportQueue.push({
        orgId: schedule.org_id,
        scheduleId: schedule.id,
        // The *due* instant, not now: a tick that ran late must still report the
        // range the schedule was due for, or a monthly report delivered an hour
        // after midnight on the 1st would cover a different month than one
        // delivered on time.
        firedAt: schedule.next_run_at ?? nowTs,
      });
      queued++;
    } catch (error) {
      // One org's bad schedule must not stop the others, the same rule the
      // rollup and SLO schedulers follow.
      console.error(`Report scheduler: could not queue schedule ${schedule.id}:`, error);
    }
  }

  if (queued > 0) console.log(`Report scheduler: queued ${queued} report(s)`);
  return { queued };
}

/**
 * Deletes expired artifacts, file first and row second.
 *
 * **File first is the load-bearing order.** Deleting the row first and then
 * failing to unlink leaves a file nothing points at and nothing will ever clean
 * up; deleting the file first and then failing to delete the row leaves a row
 * whose download 404s, which the download path already handles and which the
 * next sweep retries.
 */
export async function sweepExpiredArtifacts(): Promise<{ deleted: number }> {
  const nowTs = GetNowTimestampUTC();
  const expired = await db.getExpiredArtifacts(nowTs);
  if (expired.length === 0) return { deleted: 0 };

  const removed: number[] = [];
  for (const artifact of expired) {
    await runWithOrg(artifact.org_id, async () => {
      await deleteArtifact(artifact.storage_key);
    });
    removed.push(artifact.id);
  }
  const deleted = await db.deleteArtifactRows(removed);
  if (deleted > 0) console.log(`Report scheduler: swept ${deleted} expired artifact(s)`);
  return { deleted };
}

async function runPass(): Promise<void> {
  await runTick();
  try {
    await sweepExpiredArtifacts();
  } catch (error) {
    // The sweep failing must not stop reports being delivered.
    console.error("Report scheduler: artifact sweep failed:", error);
  }
}

const addWorker = () => {
  if (worker) return worker;
  worker = q.createWorker(getQueue(), async (_job: Job) => await runPass(), {
    concurrency: 1,
    limiter: { max: 4, duration: 60_000 },
  });
  worker.on("failed", (_job: Job | undefined, error: Error) => {
    console.error("Report scheduler failed:", error);
  });
  return worker;
};

export const start = async (options?: JobSchedulerTemplateOptions) => {
  const opts: JobSchedulerTemplateOptions = { ...(options ?? {}) };
  opts.removeOnComplete = { age: 3600, count: 50 };
  opts.removeOnFail = { age: 24 * 3600, count: 200 };

  const queue = getQueue();
  addWorker();
  // The report worker has to exist in this process too, or jobs pushed by the
  // tick would sit in Redis unclaimed.
  await reportQueue.start();

  await queue.upsertJobScheduler(`${TICK_JOB}_hourly`, { pattern: "0 * * * *" }, { name: TICK_JOB, opts });

  console.log("Report scheduler started (hourly delivery tick and artifact sweep)");
};

export const shutdown = async () => {
  if (worker) {
    await worker.close();
    worker = null;
  }
  await reportQueue.shutdown();
};

export default { start, shutdown, runTick, sweepExpiredArtifacts };
