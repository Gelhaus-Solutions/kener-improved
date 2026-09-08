import { Queue, Worker, Job } from "bullmq";
import q from "./q.js";
import { runRelayPass, runSweepPass } from "../events/relay.js";
import eventDispatchQueue from "./eventDispatchQueue.js";

// Drives the relay.
//
// Two schedulers on one queue, doing deliberately different jobs:
//
//   tick   every 1s   turns newly committed events into delivery attempts
//   sweep  every 60s  re-enqueues deliveries that are due, and revives stuck ones
//
// The tick is the happy path. The sweep is the recovery path, and it is what
// makes Redis disposable: every delivery's state is a database row, so a
// `FLUSHALL` costs at most one sweep interval of latency rather than losing
// anything. It is also the only thing that reschedules a delivery sitting in the
// retry ladder, since those wait as timestamps rather than as delayed jobs.
//
// Registering the worker is deliberately separate from `nudge`. In development
// the web process and the cron process are separate, and only the cron process
// calls `start()`; the web process may still nudge, which needs a queue producer
// and must not quietly turn a request handler into a relay worker.

let relayQueue: Queue | null = null;
let worker: Worker | null = null;
const queueName = "eventRelayQueue";
const TICK_JOB = "eventRelayTick";
const SWEEP_JOB = "eventRelaySweep";

const getQueue = () => {
  if (!relayQueue) {
    relayQueue = q.createQueue(queueName);
  }
  return relayQueue;
};

const enqueueDelivery = async (deliveryId: number, jobId: string): Promise<void> => {
  await eventDispatchQueue.push(deliveryId, jobId);
};

const addWorker = () => {
  if (worker) return worker;

  worker = q.createWorker(
    getQueue(),
    async (job: Job): Promise<void> => {
      if (job.name === SWEEP_JOB) {
        await runSweepPass(enqueueDelivery);
        return;
      }
      await runRelayPass(enqueueDelivery);
    },
    // One at a time. The relay is safe to run concurrently, but there is nothing
    // to gain: a second pass would find the first one's claim and do nothing but
    // burn a database round trip every second.
    { concurrency: 1 },
  );

  worker.on("failed", (job: Job | undefined, err: Error) => {
    // A failed pass costs a tick. Claimed-but-unpublished events are picked up
    // again once the claim expires, so there is nothing to recover by hand.
    console.error(`event relay job ${job?.name ?? "?"} failed:`, err);
  });

  return worker;
};

/**
 * Starts the relay. Call once, from the process that runs schedulers.
 *
 * Both schedulers are upserted, so restarting the process does not accumulate
 * duplicates and changing an interval here takes effect on the next boot.
 */
export const start = async () => {
  const queue = getQueue();
  addWorker();
  // The dispatch worker lives in the same process as the relay: the relay is the
  // only thing that enqueues to it, and splitting them would mean a deployment
  // where events publish and nothing delivers.
  eventDispatchQueue.addWorker();

  const jobOptions = {
    attempts: 1,
    // A tick runs every second, so a completed tick is worthless within
    // moments. Keeping a handful is enough to see the relay is alive.
    removeOnComplete: { age: 60, count: 50 },
    removeOnFail: { age: 24 * 3600 },
  };

  await queue.upsertJobScheduler(TICK_JOB, { every: 1000 }, { name: TICK_JOB, opts: jobOptions });
  await queue.upsertJobScheduler(SWEEP_JOB, { every: 60_000 }, { name: SWEEP_JOB, opts: jobOptions });

  console.log("Event relay started (1s publish tick, 60s delivery sweep)");
};

/**
 * Asks the relay to run now rather than on the next tick.
 *
 * Purely an optimisation: it turns up to a second of publish latency into
 * milliseconds, and if it fails the tick still publishes the event. Callers
 * should invoke it *after* the transaction that wrote the event has committed,
 * which `emit()` handles via `afterCommit`.
 *
 * Deduplicated so a burst of a hundred events costs one extra pass rather than a
 * hundred, and the pass would have picked all hundred up anyway.
 */
export const nudge = async (): Promise<void> => {
  try {
    await getQueue().add(
      TICK_JOB,
      {},
      {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { age: 3600 },
        // One nudge per second at most: any more would be asking the relay to do
        // work it is already about to do on its own timer.
        deduplication: { id: "event-relay-nudge", ttl: 1000 },
      },
    );
  } catch (error) {
    console.error("event relay: nudge failed, falling back to the 1s tick:", error);
  }
};

export const shutdown = async () => {
  if (worker) {
    await worker.close();
    worker = null;
  }
};

export default {
  start,
  nudge,
  shutdown,
};
