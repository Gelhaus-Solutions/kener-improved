import { runWithOrg } from "../db/orgContext.js";
import { Queue, Worker, Job, type JobSchedulerTemplateOptions } from "bullmq";
import q from "../queues/q.js";
import db from "../db/db.js";
import type { DataRetentionPolicy } from "../../types/site.js";
import { GetSiteDataByKey } from "../controllers/siteDataController.js";
import { GetNowTimestampUTC } from "../tool.js";
import { ensureMonitoringDataPartitions } from "../db/partitions.js";

let dailyCleanupQueue: Queue | null = null;
let worker: Worker | null = null;
const queueName = "dailyCleanupQueue";
const jobNamePrefix = "dailyCleanupJob";

interface DailyCleanupResult {
  skipped: boolean;
  deletedRows: number;
  retentionDays: number;
}

const defaultPolicy: DataRetentionPolicy = {
  enabled: true,
  retentionDays: 90,
};

const getQueue = () => {
  if (!dailyCleanupQueue) {
    dailyCleanupQueue = q.createQueue(queueName);
  }
  return dailyCleanupQueue;
};

const getRetentionPolicy = async (): Promise<DataRetentionPolicy> => {
  const policy = await db.getSiteDataByKey("dataRetentionPolicy");
  if (!policy?.value) {
    return defaultPolicy;
  }

  try {
    const parsed = JSON.parse(policy.value) as Partial<DataRetentionPolicy>;
    return {
      enabled: parsed.enabled ?? defaultPolicy.enabled,
      retentionDays: parsed.retentionDays ?? defaultPolicy.retentionDays,
    };
  } catch (error) {
    console.error("Failed to parse dataRetentionPolicy. Using defaults.", error);
    return defaultPolicy;
  }
};

/**
 * Days of audit_log history to keep. Deliberately independent of the monitoring
 * data retention policy: audit evidence is usually kept far longer than
 * telemetry, and tying them together would mean shortening one to shorten the
 * other.
 */
const DEFAULT_AUDIT_RETENTION_DAYS = 365;

const pruneAuditLog = async (): Promise<number> => {
  try {
    const raw = await GetSiteDataByKey("auditRetentionDays");
    const days = Math.max(1, Math.floor(Number(raw) || DEFAULT_AUDIT_RETENTION_DAYS));
    const cutoff = GetNowTimestampUTC() - days * 86400;
    const removed = await db.pruneAuditLog(cutoff);
    if (removed > 0) console.log(`Pruned ${removed} audit_log row(s) older than ${days} days`);
    return removed;
  } catch (error) {
    // Never let audit pruning fail the monitoring-data cleanup it rides along
    // with; that is the job people actually notice not running.
    console.error("Audit log pruning failed:", error);
    return 0;
  }
};

/**
 * How long an expired session row is kept after it stops working.
 *
 * Not zero, and the delay is the point: "when did that session end, and was it
 * revoked or did it just lapse" is a question asked after an incident, and a row
 * deleted the moment it expired cannot answer it. It stops being usable at
 * `expires_at` regardless; this only governs when the record is discarded.
 */
const SESSION_GRACE_DAYS = 30;

const pruneSessions = async (): Promise<number> => {
  try {
    const cutoff = GetNowTimestampUTC() - SESSION_GRACE_DAYS * 86400;
    const removed = await db.pruneSessions(cutoff);
    if (removed > 0) console.log(`Pruned ${removed} session row(s) that expired over ${SESSION_GRACE_DAYS} days ago`);
    return removed;
  } catch (error) {
    // Same reasoning as the audit prune: never fail the monitoring-data cleanup
    // over a housekeeping task riding along with it.
    console.error("Session pruning failed:", error);
    return 0;
  }
};

/**
 * Creates the `monitoring_data` partitions that do not exist yet (B1a).
 *
 * A no-op unless an operator has run `npm run pg:partition-monitoring-data`, so
 * it costs one catalogue lookup on every other install. Kept here rather than in
 * a scheduler of its own because it is daily housekeeping on the same table this
 * job already prunes, and one more queue to start, watch and shut down is not
 * worth a `CREATE TABLE` that runs three times a year.
 *
 * Cross-tenant, like session pruning: partitions are a property of the table,
 * not of an org, so this runs once outside the per-org loop.
 */
const ensurePartitions = async (): Promise<string[]> => {
  try {
    const created = await ensureMonitoringDataPartitions(db.knexForPartitionMaintenance(), GetNowTimestampUTC());
    if (created.length > 0) console.log(`Created monitoring_data partition(s): ${created.join(", ")}`);
    return created;
  } catch (error) {
    // Same reasoning as the audit and session prunes: housekeeping riding along
    // must never fail the retention delete people actually notice. A missing
    // partition is also not urgent — writes land in the DEFAULT partition until
    // the next pass, which is exactly what it is there for.
    console.error("monitoring_data partition maintenance failed:", error);
    return [];
  }
};

const runDailyCleanup = async (): Promise<DailyCleanupResult> => {
  const policy = await getRetentionPolicy();
  const retentionDays = Math.max(1, Math.floor(policy.retentionDays || defaultPolicy.retentionDays));
  console.log(`Data retention policy: enabled=${policy.enabled}, retentionDays=${retentionDays}`);
  if (!policy.enabled) {
    return {
      skipped: true,
      deletedRows: 0,
      retentionDays,
    };
  }

  const deletedRows = await db.background(retentionDays);

  return {
    skipped: false,
    deletedRows,
    retentionDays,
  };
};

const addWorker = () => {
  if (worker) return worker;

  worker = q.createWorker(getQueue(), async (_job: Job) => {
    console.log("Running daily monitoring_data cleanup...");

    // I3d: one of exactly three genuinely cross-tenant jobs.
    //
    // Retention is per-org configuration - `dataRetentionPolicy` and
    // `auditRetentionDays` are `site_data` rows, and `site_data` is per-org as of
    // I3b - so this cannot be one sweep over every row. It is a loop over orgs,
    // each iteration inside that org's context, which is also what makes the
    // pruning queries scoped without any of them changing.
    //
    // The job payload carries no `org_id`, so `createWorker` runs it under
    // `runAcrossOrgs`; reading the org list is exactly what that is for.
    const orgIds = await db.getActiveOrgIds();

    let deletedRows = 0;
    let prunedAuditRows = 0;
    let skipped = true;
    let retentionDays = defaultPolicy.retentionDays;

    for (const orgId of orgIds) {
      // One org failing must not stop the others: a bad retention value in one
      // tenant is not a reason to stop pruning every other tenant's data.
      try {
        const perOrg = await runWithOrg(orgId, async () => {
          const result = await runDailyCleanup();
          const audit = await pruneAuditLog();
          return { result, audit };
        });
        deletedRows += perOrg.result.deletedRows;
        prunedAuditRows += perOrg.audit;
        if (!perOrg.result.skipped) skipped = false;
        retentionDays = perOrg.result.retentionDays;
      } catch (error) {
        console.error(`Daily cleanup failed for org ${orgId}:`, error);
      }
    }

    // Sessions belong to users, not to orgs, so this one stays a single sweep.
    const prunedSessions = await pruneSessions();

    // After the deletes, not before: a partition created now is for a month
    // nothing has written to yet, and doing it last keeps the retention delete
    // first in line for the table.
    const createdPartitions = await ensurePartitions();

    return { skipped, deletedRows, retentionDays, prunedAuditRows, prunedSessions, createdPartitions };
  });

  worker.on("failed", (_job: Job | undefined, err: Error) => {
    console.error("Daily cleanup scheduler failed:", err);
  });

  return worker;
};

/**
 * Start daily cleanup scheduler
 * Runs at midnight UTC (00:00 UTC) every day
 */
export const start = async (options?: JobSchedulerTemplateOptions) => {
  if (!options) {
    options = {};
  }

  options.removeOnComplete = {
    age: 24 * 3600,
    count: 100,
  };
  options.removeOnFail = {
    age: 7 * 24 * 3600,
  };

  const queue = getQueue();
  addWorker();

  await queue.upsertJobScheduler(
    jobNamePrefix + "_midnight_utc",
    {
      pattern: "0 0 * * *",
    },
    {
      opts: options,
    },
  );

  console.log("Daily cleanup scheduler started (runs at 00:00 UTC)");
};

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
