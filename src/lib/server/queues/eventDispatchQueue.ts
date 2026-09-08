import { Queue, Worker, Job, type JobsOptions } from "bullmq";
import q from "./q.js";
import { runDelivery } from "../events/dispatch.js";

// Delivery attempts for the event bus.
//
// The one thing to understand about this queue is that **it does not retry**.
// `attempts: 1` is not a simplification, it is the design: retry state lives in
// `event_deliveries.next_attempt_at` so that it survives a Redis flush, is
// visible to an operator, and can hold a nine-hour ladder without a job sitting
// in Redis for nine hours. See events/retry.ts.
//
// A job here therefore means "try this delivery once, now". Whether there is a
// next time, and when, is decided by the dispatcher and written to the database.

let dispatchQueue: Queue | null = null;
let worker: Worker | null = null;
const queueName = "eventDispatchQueue";

interface DispatchJobData {
  deliveryId: number;
}

const getQueue = () => {
  if (!dispatchQueue) {
    dispatchQueue = q.createQueue(queueName);
  }
  return dispatchQueue;
};

export const addWorker = () => {
  if (worker) return worker;

  worker = q.createWorker(getQueue(), async (job: Job): Promise<void> => {
    const { deliveryId } = job.data as DispatchJobData;
    // runDelivery never throws; every outcome is a status on the row. A throw
    // here would hand control back to BullMQ's retry, which is exactly the
    // mechanism this queue exists to bypass.
    await runDelivery(deliveryId);
  });

  worker.on("failed", (job: Job | undefined, err: Error) => {
    console.error(`event dispatch job ${job?.id ?? "?"} failed:`, err);
  });

  return worker;
};

/**
 * Queues one delivery attempt.
 *
 * `jobId` is supplied by the caller and is derived from the delivery's identity,
 * so a relay pass that runs twice adds the same id twice and BullMQ keeps one.
 * That is the first of the two duplicate defences; the second is the conditional
 * status transition in the dispatcher, which catches the case where the first
 * job had already completed and been removed.
 */
export const push = async (deliveryId: number, jobId: string, options: JobsOptions = {}) => {
  const queue = getQueue();

  await queue.add(
    "eventDispatchJob",
    { deliveryId },
    {
      ...options,
      jobId,
      // See the file header. The ladder is in the database.
      attempts: 1,
      removeOnComplete: { age: 3600, count: 1000 },
      // q.ts defaults this to `false`, which keeps failed jobs in Redis forever.
      // The row in event_deliveries is the durable record; the job is not.
      removeOnFail: { age: 24 * 3600 },
    },
  );
};

export const shutdown = async () => {
  if (worker) {
    await worker.close();
    worker = null;
  }
};

export default {
  push,
  addWorker,
  shutdown,
};
