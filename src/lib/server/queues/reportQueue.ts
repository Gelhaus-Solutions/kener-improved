import { Queue, Worker, Job, type JobsOptions } from "bullmq";
import q from "./q.js";
import db from "../db/db.js";
import { runWithOrg } from "../db/orgContext.js";
import { GetNowTimestampUTC } from "../tool.js";
import { deliverArtifact, renderScheduledReport, resolveRecipients } from "../reports/reportDelivery.js";
import { computeNextRunAt } from "../reports/reportSchedule.js";

/**
 * Rendering and delivering one scheduled report (F4).
 *
 * **A queue rather than doing it in the scheduler tick.** Rendering a year of
 * hourly CSV takes seconds and writes hundreds of megabytes; doing that inline
 * would hold the hourly tick open and, with several schedules due at once, would
 * serialise them behind whichever is slowest while the tick's own lock ran down.
 *
 * `concurrency: 1` for the reason every other fork-added worker has it: this
 * shares the small worker connection pool with the monitor checks, and the
 * checking is what must not be starved. A monthly report being three minutes
 * late is nothing; a missed check is an outage nobody saw.
 */

const queueName = "reportQueue";
const jobName = "reportJob";

let reportQueue: Queue | null = null;
let worker: Worker | null = null;

export interface ReportJobData {
  orgId: number;
  scheduleId: number;
  /** The instant the schedule was due, which is what the range resolves against. */
  firedAt: number;
  /** Absent for a scheduled run; set when somebody pressed "send now". */
  manual?: boolean;
}

const getQueue = () => {
  if (!reportQueue) reportQueue = q.createQueue(queueName);
  return reportQueue;
};

/**
 * Advances the schedule past this firing, whatever the outcome.
 *
 * **`next_run_at` moves even when the render failed**, and that is deliberate: a
 * schedule whose next run stayed in the past would be picked up by every hourly
 * tick forever, re-rendering and re-failing, and a failure that mails nothing is
 * quiet enough that nobody would notice for weeks. The error is recorded on the
 * row instead, where the admin screen shows it.
 */
async function advance(scheduleId: number, firedAt: number, error: string | null): Promise<void> {
  const schedule = await db.getReportScheduleById(scheduleId);
  if (!schedule) return;
  const now = GetNowTimestampUTC();
  await db.updateReportSchedule(scheduleId, {
    last_run_at: now,
    last_error: error,
    next_run_at: computeNextRunAt(schedule.rrule, schedule.timezone, Math.max(firedAt, now)),
    updated_at: now,
  });
}

async function handle(data: ReportJobData): Promise<void> {
  await runWithOrg(data.orgId, async () => {
    const schedule = await db.getReportScheduleById(data.scheduleId);
    if (!schedule) return;

    try {
      const artifact = await renderScheduledReport(schedule, data.firedAt);
      const recipients = await resolveRecipients(schedule);
      const baseUrl = process.env.ORIGIN ?? "";
      const queued = await deliverArtifact(schedule, artifact, recipients, baseUrl);
      console.log(
        `Report "${schedule.name}": ${artifact.filename} (${artifact.sizeBytes} bytes), ${queued} recipient(s)`,
      );
      if (!data.manual) await advance(schedule.id, data.firedAt, null);
      else
        await db.updateReportSchedule(schedule.id, {
          last_run_at: GetNowTimestampUTC(),
          last_error: null,
          updated_at: GetNowTimestampUTC(),
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Report "${schedule.name}" failed:`, message);
      if (!data.manual) await advance(schedule.id, data.firedAt, message);
      else
        await db.updateReportSchedule(schedule.id, {
          last_run_at: GetNowTimestampUTC(),
          last_error: message,
          updated_at: GetNowTimestampUTC(),
        });
      throw error;
    }
  });
}

const addWorker = () => {
  if (worker) return worker;
  worker = q.createWorker(getQueue(), async (job: Job) => await handle(job.data as ReportJobData), {
    concurrency: 1,
  });
  worker.on("failed", (_job: Job | undefined, error: Error) => {
    console.error("Report job failed:", error);
  });
  return worker;
};

export const push = async (data: ReportJobData, options?: JobsOptions) => {
  const opts: JobsOptions = { ...(options ?? {}) };
  opts.removeOnComplete = opts.removeOnComplete ?? { age: 24 * 3600, count: 100 };
  // Set explicitly: `q.ts` defaults `removeOnFail` to `false`, which keeps every
  // failed job forever and fills Redis quietly. The item asks for this by name.
  opts.removeOnFail = opts.removeOnFail ?? { age: 7 * 24 * 3600, count: 200 };
  // **Deduplicated on the schedule and the instant it was due.** Two overlapping
  // hourly ticks, or a tick retried after a restart, must not mail the same
  // report twice - and the pair is exactly what identifies one firing.
  //
  // **Separated by `-`, never `:`.** BullMQ rejects a custom job id containing a
  // colon ("Custom Id cannot contain :") because it namespaces its own Redis
  // keys with one. It throws at `add()` time, so the failure is not a type error
  // or a build error: the hourly tick logs and queues nothing, every hour,
  // forever, and no report is ever delivered. The driver caught this on its
  // first run; nothing else would have.
  opts.jobId =
    opts.jobId ?? `${jobName}-${data.orgId}-${data.scheduleId}-${data.firedAt}${data.manual ? "-manual" : ""}`;
  // **Pushing does not start a worker, deliberately.** The obvious shape - call
  // `addWorker()` here, as several older queues in this repo do - means every
  // process that enqueues also consumes. Two things break on that:
  //
  //   - `runReportScheduleNow` is a manage action, so it runs in the **web**
  //     process; rendering a year of CSV there is exactly the work `startup.ts`
  //     keeps out of the web process on purpose.
  //   - a short-lived process that pushes and exits can claim the job on its way
  //     out, leaving it stalled until BullMQ re-delivers it.
  //
  // The second is not hypothetical: it is what the F4 driver hit, and the
  // symptom was a job that was queued, logged as queued, and then simply never
  // ran. `reportScheduler.start()` owns the worker.
  return await getQueue().add(jobName, data, opts);
};

export const start = async () => {
  addWorker();
};

export const shutdown = async () => {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (reportQueue) {
    await reportQueue.close();
    reportQueue = null;
  }
};

export default { push, start, shutdown };
