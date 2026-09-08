/**
 * Email Queue - handles individual email sending
 * Receives template, variables, and single recipient email
 * Each job sends to exactly one recipient for privacy
 */

import { Queue, Worker, Job, type JobsOptions } from "bullmq";
import q from "./q.js";
import sendEmail from "../notification/email_notification.js";
import { CreateMD5Hash } from "../controllers/commonController.js";
import db from "../db/db.js";
import { nextAttemptAt, MAX_DELIVERY_ATTEMPTS } from "../events/retry.js";

let emailQueue: Queue | null = null;
let worker: Worker | null = null;
const queueName = "emailQueue";
const jobNamePrefix = "emailJob";

export interface EmailJobData {
  toEmails: string[];
  templateHtmlBody: string;
  templateSubject: string;
  templateTextBody?: string;
  variables: Record<string, string | number | boolean>;
  fromEmail?: string;
  /**
   * The `event_deliveries` row this send belongs to, when there is one.
   *
   * Optional, and the smallest edit that puts email on the delivery log: the
   * caller creates the row and passes its id, and this queue writes the outcome
   * back to it. Sends with no id (verification codes, OTPs) behave exactly as
   * before and stay off the log, which is right - they are transactional mail to
   * one person, not a notification anyone audits.
   */
  delivery_id?: number;
}

const getQueue = () => {
  if (!emailQueue) {
    emailQueue = q.createQueue(queueName);
  }
  return emailQueue;
};

/**
 * Writes the send's outcome to its `event_deliveries` row, when it has one.
 *
 * Never throws. The email has already been sent or already failed by the time
 * this runs, and letting a logging failure change that verdict would be worse
 * than losing the log line.
 *
 * Note this queue keeps its own BullMQ retries (`attempts: 3` from q.ts), unlike
 * the webhook dispatch queue. Each of those attempts updates the same row, so
 * `attempts` on the row counts real send attempts either way, and the row only
 * goes DEAD once the ladder is genuinely exhausted.
 */
async function recordDeliveryOutcome(
  deliveryId: number | undefined,
  ok: boolean,
  error: string | null,
  durationMs: number,
): Promise<void> {
  if (!deliveryId) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const delivery = await db.getEventDeliveryById(deliveryId);
    if (!delivery) return;

    const attempts = delivery.attempts + 1;
    const next = ok ? null : nextAttemptAt(attempts, now);
    await db.completeEventDeliveryAttempt(deliveryId, {
      status: ok ? "DELIVERED" : next === null ? "DEAD" : "FAILED",
      attempts,
      next_attempt_at: next,
      response_code: null,
      response_body: null,
      error: error ? error.slice(0, 2000) : null,
      duration_ms: durationMs,
      updated_at: now,
    });
    if (!ok && next === null) {
      console.error(`email: delivery ${deliveryId} is DEAD after ${attempts} of ${MAX_DELIVERY_ATTEMPTS} attempts`);
    }
  } catch (e) {
    console.error(`email: could not record the outcome of delivery ${deliveryId}:`, e);
  }
}

const addWorker = () => {
  if (worker) return worker;

  worker = q.createWorker(getQueue(), async (job: Job): Promise<void> => {
    const { toEmails, templateHtmlBody, templateSubject, templateTextBody, variables, fromEmail } =
      job.data as EmailJobData;

    const { delivery_id } = job.data as EmailJobData;
    const startedAt = Date.now();

    try {
      await sendEmail(
        templateHtmlBody,
        templateSubject,
        variables,
        toEmails, // Single recipient array
        fromEmail,
        templateTextBody,
      );
      await recordDeliveryOutcome(delivery_id, true, null, Date.now() - startedAt);
      // console.log(`📧 Email sent to ${toEmails}`);
    } catch (error) {
      console.error(`Failed to send email to ${toEmails}:`, error);
      await recordDeliveryOutcome(
        delivery_id,
        false,
        error instanceof Error ? error.message : String(error),
        Date.now() - startedAt,
      );
      throw error; // Re-throw to trigger retry
    }
  });

  worker.on("completed", (job: Job) => {
    // Completed silently
  });

  worker.on("failed", (job: Job | undefined, err: Error) => {
    const toEmails = job?.data?.toEmail || "unknown";
    console.error(`❌ Email job failed`, err.message);
  });

  return worker;
};

/**
 * Push an email sending job to the queue
 * @param jobData - Email job data with single recipient
 * @param options - BullMQ job options
 */
export const push = async (jobData: EmailJobData, options?: JobsOptions) => {
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

  // Use deduplication to prevent duplicate emails to same recipient
  const deDupId = `email-${CreateMD5Hash(jobData.toEmails.join(","))}-${Date.now()}`;
  if (!options.deduplication) {
    options.deduplication = {
      id: deDupId,
    };
  }

  await queue.add(`${jobNamePrefix}-send`, jobData, options);
};

/**
 * Graceful shutdown
 */
export const shutdown = async () => {
  if (worker) {
    await worker.close();
    worker = null;
  }
};

export default {
  push,
  shutdown,
};
