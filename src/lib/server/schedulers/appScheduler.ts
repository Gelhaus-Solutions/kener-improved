import { runWithOrg } from "../db/orgContext.js";
import type { MonitorRecordTyped } from "../types/db";

import { Queue, Worker, Job, type JobsOptions, type JobSchedulerTemplateOptions } from "bullmq";
import q from "../queues/q.js";
import { HashString } from "../tool.js";
import { getSchedulers, addJobToSchedulerQueue, removeJobFromSchedulerQueue } from "./monitorSchedulers.js";

import { GetMonitorsParsed } from "../controllers/controller.js";
import { UpdateMaintenanceEventStatuses } from "../controllers/maintenanceController.js";
import { RebuildAlertConfigTagIndex } from "../cache/alertConfigTags.js";
import db from "../db/db.js";

let appSchedulerQueue: Queue | null = null;
let worker: Worker | null = null;
const queueName = "appSchedulerQueue";
const jobNamePrefix = "mainJob";

interface JobData {}

const getQueue = () => {
  if (!appSchedulerQueue) {
    appSchedulerQueue = q.createQueue(queueName);
  }
  return appSchedulerQueue;
};

const addWorker = () => {
  if (worker) return worker;

  worker = q.createWorker(getQueue(), async (job: Job) => {
    // KENER-132: per active org, not one unscoped read.
    //
    // This job's payload carries no `org_id`, so `q.ts` runs it under
    // `runAcrossOrgs` and `BaseRepository.table()` comes back unscoped. A single
    // `GetMonitorsParsed({ status: "ACTIVE" })` therefore returned *every* org's
    // monitors, suspended orgs included, and gave each one a scheduler - so the
    // one lever that is meant to stop a tenant costing money stopped nothing.
    //
    // `getActiveOrgIds()` filters `status = 'ACTIVE'`, which is the same call the
    // maintenance sweep below already makes. The two halves of this scheduler
    // used to disagree about whether a suspended org exists; now they do not.
    //
    // Tearing the schedulers down needs no extra code: a suspended org's monitors
    // simply stop appearing in `activeMonitors`, and the reconciliation below
    // already removes any scheduler with no matching monitor. Re-activating the
    // org puts them back on the next pass, for the same reason.
    const activeMonitors: Array<MonitorRecordTyped & { hash: string }> = [];
    for (const orgId of await db.getActiveOrgIds()) {
      const monitors = await runWithOrg(orgId, () => GetMonitorsParsed({ status: "ACTIVE" }));
      for (const monitor of monitors) {
        activeMonitors.push({
          ...monitor,
          hash: monitor.tag + "::" + HashString(JSON.stringify(monitor)),
        });
      }
    }

    const minNumOfWorkers = Math.max(activeMonitors.length, 1);
    //get all schedulers
    const schedulers = await getSchedulers(minNumOfWorkers);

    const activeMap = new Map<string, MonitorRecordTyped>();
    for (let i = 0; i < activeMonitors.length; i++) {
      const monitor = activeMonitors[i];
      activeMap.set(monitor.hash, monitor);
    }

    //remove schedulers that are not in active monitors
    for (let i = 0; i < schedulers.length; i++) {
      const existingJob = schedulers[i];

      const matchingMonitor = activeMap.get(existingJob.name);
      if (!matchingMonitor) {
        //remove scheduler
        console.log("REMOVING INACTIVE SCHEDULER: " + existingJob.name.split("::")[0]);
        await removeJobFromSchedulerQueue(existingJob.name, minNumOfWorkers);
      }
    }

    //active job map
    const activeJobMap = new Map<string, any>();
    for (let i = 0; i < schedulers.length; i++) {
      const job = schedulers[i];
      activeJobMap.set(job.name, job);
    }

    //create schedulers for active monitors that don't have one
    for (let i = 0; i < activeMonitors.length; i++) {
      const monitor = activeMonitors[i];
      const existingJob = activeJobMap.get(monitor.hash);
      if (!existingJob && monitor.cron) {
        await addJobToSchedulerQueue(minNumOfWorkers, monitor, monitor.hash);
        console.log("ADDING NEW SCHEDULER: " + monitor.tag);
      }
    }

    // I3d: cross-tenant, so a loop over orgs.
    //
    // This transitions maintenance events between states, which emits onto the
    // bus, and an event with no owning org is not something any consumer can
    // route.
    //
    // This loop used to be the only one here, on the reasoning that the monitor
    // sweep above needed none because each monitor record carries its own
    // `org_id` and so the job it enqueues is already scoped. That was true and
    // beside the point: it answers "which org does this job run as", not "should
    // this org's monitors run at all". KENER-132 is the second question, and the
    // sweep above now asks it the same way this loop does.
    for (const orgId of await db.getActiveOrgIds()) {
      try {
        await runWithOrg(orgId, () => UpdateMaintenanceEventStatuses());
      } catch (error) {
        console.error(`Maintenance status update failed for org ${orgId}:`, error);
      }
    }

    // Refresh the index alertingQueue.push uses to skip monitors with no alert
    // config. One query here replaces two per monitor per minute there. Failures
    // are swallowed inside the helper: the marker then expires and push() goes
    // back to querying, which is the safe direction.
    await RebuildAlertConfigTagIndex(await db.getMonitorTagsWithActiveAlertConfigs());

    return activeMonitors.length;
  });

  // worker.on("completed", (job: Job, returnvalue: any) => {
  //   console.log(`Queue: `, returnvalue);
  // });

  return worker;
};

export const start = async (options?: JobSchedulerTemplateOptions) => {
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
  await queue.upsertJobScheduler(
    jobNamePrefix + "_main_job",
    {
      every: 10000, // Job will repeat every 10000 milliseconds (10 seconds)
    },
    {
      opts: options,
    },
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
  start,
  shutdown,
};
