/**
 * Subscriber Queue - receives subscription variable data and trigger id
 * Finds all subscribers for a given trigger and sends emails via senderQueue
 */

import { Queue, Worker, Job, type JobsOptions } from "bullmq";
import q from "./q.js";
import { GetAllSiteData } from "../controllers/controller.js";
import { siteDataToVariables } from "../notification/notification_utils.js";
import type { SubscriptionVariableMap } from "../notification/types.js";
import { GetGeneralEmailTemplateById } from "../controllers/generalTemplateController.js";
import { GetActiveEmailMethodsForEventType } from "../controllers/userSubscriptionsController.js";
import db from "../db/db.js";
import { EMAIL_CONSUMER } from "../events/consumers/email.js";
import emailQueue from "./emailQueue.js";
let subscriberQueue: Queue | null = null;
let worker: Worker | null = null;
const queueName = "subscriberQueue";
const jobNamePrefix = "subscriberJob";

interface SubscriberJobData {
  variables: SubscriptionVariableMap;
  /**
   * The outbox event this notification came from, when there is one.
   *
   * Optional because not every subscriber notification is bus-driven yet.
   * When present, each recipient gets an `event_deliveries` row so a failed
   * email shows up on the delivery log beside a failed webhook, and can be
   * retried from there. H8c makes this the only path.
   */
  event_id?: string;
  org_id?: number;
}

const getQueue = () => {
  if (!subscriberQueue) {
    subscriberQueue = q.createQueue(queueName);
  }
  return subscriberQueue;
};

/**
 * Creates the delivery row for one recipient and returns its id.
 *
 * The rendered message is stored on the row, which is what makes a retry from
 * the delivery log resend *this* update rather than a fresh approximation of it.
 * See events/consumers/email.ts.
 *
 * Returns undefined on failure rather than throwing: not being able to log a
 * notification is not a reason to withhold it.
 */
async function createDeliveryRow(
  eventId: string,
  orgId: number,
  recipient: { subscriber_method_id: number; email: string },
  emailJob: Record<string, unknown>,
): Promise<number | undefined> {
  try {
    const now = Math.floor(Date.now() / 1000);
    await db.insertEventDeliveries([
      {
        event_id: eventId,
        org_id: orgId,
        consumer: EMAIL_CONSUMER,
        target_type: "subscriber_method",
        target_id: String(recipient.subscriber_method_id),
        // IN_FLIGHT, not PENDING: the job is already on its way to emailQueue,
        // and a PENDING row would be picked up by the relay's sweeper and sent
        // a second time.
        status: "IN_FLIGHT",
        attempts: 0,
        next_attempt_at: null,
        last_attempt_at: now,
        response_code: null,
        response_body: null,
        error: null,
        request_body: JSON.stringify(emailJob),
        request_headers: JSON.stringify({ to: recipient.email }),
        duration_ms: null,
        created_at: now,
        updated_at: now,
      },
    ]);
    const rows = await db.getEventDeliveriesByEventId(eventId);
    return rows.find((r) => r.consumer === EMAIL_CONSUMER && r.target_id === String(recipient.subscriber_method_id))
      ?.id;
  } catch (error) {
    console.error("subscriber: could not create a delivery row, sending anyway:", error);
    return undefined;
  }
}

const addWorker = () => {
  if (worker) return worker;

  worker = q.createWorker(getQueue(), async (job: Job): Promise<void> => {
    const { variables, event_id, org_id } = job.data as SubscriberJobData;

    try {
      // Get site data for template variables
      const siteData = await GetAllSiteData();
      const templateSiteVars = siteDataToVariables(siteData);

      const template = await GetGeneralEmailTemplateById("subscription_update");
      if (!template) {
        throw new Error("Subscription email template not found");
      }
      const emailVars = {
        ...templateSiteVars,
        ...variables,
      };

      const eventType = variables.event_type;

      // Methods rather than bare addresses: a delivery row needs a stable
      // identity for the recipient, and two subscribers can share an address.
      const recipients = await GetActiveEmailMethodsForEventType(eventType);

      if (recipients.length === 0) {
        console.log(`📭 No active subscribers for event type: ${eventType}`);
        return;
      }

      // Queue individual emails for each subscriber (for privacy - no shared recipients)
      for (const recipient of recipients) {
        const emailJob = {
          toEmails: [recipient.email],
          templateHtmlBody: template.template_html_body || "",
          templateSubject: template.template_subject || "Event Update",
          templateTextBody: template.template_text_body || "",
          variables: emailVars,
        };

        // One row per recipient, written before the send so a message that never
        // leaves is still on the log. Without this a failed notification lives
        // only in Redis for 24 hours and nobody can see it at all.
        const deliveryId = event_id ? await createDeliveryRow(event_id, org_id ?? 1, recipient, emailJob) : undefined;

        await emailQueue.push({ ...emailJob, delivery_id: deliveryId });
      }

      console.log(`📮 Queued ${recipients.length} subscription email(s) for event: ${eventType}`);
    } catch (error) {
      console.error("Error processing subscriber queue job:", error);
      throw error;
    }
  });

  worker.on("completed", (job: Job) => {
    // const { monitor_tags } = job.data as SubscriberJobData;
    // console.log(`✅ Subscriber job completed for monitors: ${monitor_tags.join(", ")}`);
  });

  worker.on("failed", (job: Job | undefined, err: Error) => {
    console.error("❌ Subscriber job failed:", err.message);
  });

  return worker;
};

/**
 * Push a subscriber notification job to the queue
 */
export const push = async (
  variables: SubscriptionVariableMap,
  options?: JobsOptions,
  /**
   * The outbox event this notification came from, when the caller has one.
   *
   * A third parameter rather than a field on `variables`: those go into the
   * email template, and an event id is plumbing, not content.
   */
  context: { event_id?: string; org_id?: number } = {},
) => {
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

  // Use deduplication to prevent duplicate notifications
  const deDupId = `subscriber-${variables.event_type}-${variables.update_id}-${Date.now()}`;
  if (!options.deduplication) {
    options.deduplication = {
      id: deDupId,
    };
  }

  await queue.add(
    `${jobNamePrefix}_${variables.update_id}`,
    {
      variables,
      event_id: context.event_id,
      org_id: context.org_id,
    },
    options,
  );
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
