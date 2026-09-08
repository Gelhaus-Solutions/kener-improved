import { runWithOrg, runAcrossOrgs, getOrgContext } from "../db/orgContext.js";
import { redisIOConnection } from "../redisConnector.js";
import db from "../db/db.js";
import {
  Queue,
  Worker,
  Job,
  type QueueOptions,
  type WorkerOptions,
  type Processor,
  type ConnectionOptions,
} from "bullmq";

//create and return queue instance given name and options
export const createQueue = (name: string, options?: Omit<QueueOptions, "connection" | "prefix">) => {
  let opts: QueueOptions = {
    connection: redisIOConnection() as ConnectionOptions,
    ...options,
  };
  opts.prefix = "kener"; //set prefix to name
  opts.defaultJobOptions = {
    attempts: 3, //number of retries
    backoff: {
      type: "exponential",
      delay: 5000, //5 seconds
    },
    removeOnComplete: true, //remove job on completion
    removeOnFail: false, //do not remove job on failure
  };
  return stampOrgOnAdd(new Queue(name, opts));
};

/**
 * Makes every job carry the organisation it was enqueued for.
 *
 * The symmetric half of what `createWorker` does on the way out: enqueue stamps
 * the ambient org onto the payload, the worker reads it back and enters it. Done
 * here rather than at the ten-odd `queue.add(...)` call sites because a call site
 * that forgets is silent - the job runs, in whatever org happens to be ambient in
 * the worker - and there is no version of this codebase where all ten stay
 * correct through a sync.
 *
 * A payload that already names an `org_id` keeps it: `subscriberQueue` and the
 * event relay pass one explicitly, and an explicit value is always the more
 * specific intent.
 *
 * Under `runAcrossOrgs` nothing is stamped, which is what lets the three
 * cross-tenant schedulers enqueue per-org work without inheriting a scope they
 * deliberately do not have.
 */
function stampOrgOnAdd(queue: Queue): Queue {
  const originalAdd = queue.add.bind(queue);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (queue as any).add = (name: string, data: unknown, options?: unknown) => {
    const ctx = getOrgContext();
    if (ctx?.orgId != null && data && typeof data === "object" && !Array.isArray(data)) {
      const payload = data as Record<string, unknown>;
      if (payload.org_id === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return originalAdd(name, { ...payload, org_id: ctx.orgId } as any, options as any);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return originalAdd(name, data as any, options as any);
  };
  return queue;
}

//create and return worker instance given queue, processor, and options
export const createWorker = <T = unknown, R = unknown>(
  queue: Queue,
  processor: Processor<T, R>,
  options?: Omit<WorkerOptions, "connection" | "prefix">,
) => {
  const opts: WorkerOptions = {
    connection: redisIOConnection() as ConnectionOptions,
    prefix: "kener",
    concurrency: 5,
    ...options,
  };
  // Route every job's database access to the worker pool. This is the single
  // chokepoint all BullMQ workers and schedulers flow through, so wrapping here
  // isolates background work from the web request pool (see db/poolContext.ts).
  // Sandboxed (string/URL) processors run out-of-process and pass through.
  //
  // I3d rides the same chokepoint for tenancy. A job's payload carries the org
  // it was enqueued for, and entering that org here means no processor has to
  // know tenancy exists - exactly as none of them knows which pool it is on.
  //
  // **A job with no `org_id` runs across orgs, not in the default one.** That is
  // deliberate: the three schedulers that genuinely fan out across tenants are
  // the only jobs without one, and they establish an org per tenant themselves.
  // Defaulting to org 1 instead would mean a mis-enqueued job silently writes
  // into the default tenant, which is the failure this whole design exists to
  // make impossible. Under `runAcrossOrgs` a tenant query is simply unscoped,
  // and the per-org loops inside these jobs supply the scope.
  const wrapped: Processor<T, R> =
    typeof processor === "function"
      ? (job, token) =>
          db.runInWorkerContext(() => {
            const orgId = (job?.data as { org_id?: number } | undefined)?.org_id;
            const run = () => Promise.resolve(processor(job, token));
            return typeof orgId === "number" ? runWithOrg(orgId, run) : runAcrossOrgs(run);
          })
      : processor;
  return new Worker<T, R>(queue.name, wrapped, opts);
};

export default {
  createQueue,
  createWorker,
};
