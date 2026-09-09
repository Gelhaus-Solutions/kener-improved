import db from "../../db/db.js";
import emailQueue, { type EmailJobData } from "../../queues/emailQueue.js";
import type { EventConsumer, OutboxEvent, DeliveryTarget, DeliveryResult } from "../types.js";

// Subscriber email, as far as the delivery log is concerned.
//
// **This consumer creates no deliveries of its own.** `targets()` returns an
// empty list on purpose, so the relay never routes an event here. Subscriber
// email still flows the way it always has, from `subscriberQueue` into
// `emailQueue`, and that path writes its own `event_deliveries` rows so a failed
// email is visible next to a failed webhook.
//
// What this consumer exists for is the other half of that screen: the retry
// button. A dispatch goes through the consumer registry, so a delivery whose
// consumer is not registered goes DEAD with "no consumer registered as email".
// Registering this makes an emailed delivery retryable without the consumer
// itself owning the primary send path.
//
// **After the P6 cutover this consumer serves history, and it has to stay
// registered for exactly that reason.** Once `subscribers` is live,
// `subscriberQueue.push` returns without doing anything, so no new rows are
// written under this name - but every row written before the flip is still on
// the delivery log with `email` in its consumer column, and deregistering this
// would turn each one's retry button into "no consumer registered as email".
// The rows are the reason, not the code path.

export const EMAIL_CONSUMER = "email";

/**
 * Rebuilds the message from the stored request body.
 *
 * A webhook can be regenerated from its event; a subscriber email cannot,
 * because the template and its rendered variables are gone by the time anyone
 * clicks retry. So the send is stored on the delivery row when it is first
 * attempted, and a retry replays exactly what was sent rather than approximating
 * it - which for an email is the difference between resending the update and
 * sending a different one.
 */
function parseStoredEmail(requestBody: string | null): EmailJobData | null {
  if (!requestBody) return null;
  try {
    const parsed = JSON.parse(requestBody) as EmailJobData;
    if (!Array.isArray(parsed?.toEmails) || parsed.toEmails.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export const emailConsumer: EventConsumer = {
  name: EMAIL_CONSUMER,
  mode: "live",
  ordered: false,

  // See the file header: the relay must not route here yet.
  targets(): DeliveryTarget[] {
    return [];
  },

  async deliver(_event: OutboxEvent, target: DeliveryTarget): Promise<DeliveryResult> {
    const delivery = (await db.getEventDeliveriesByEventId(_event.event_id)).find(
      (d) => d.consumer === EMAIL_CONSUMER && d.target_type === target.target_type && d.target_id === target.target_id,
    );

    const job = parseStoredEmail(delivery?.request_body ?? null);
    if (!job) {
      // Written before request bodies were stored, or stored malformed. Retrying
      // would send nothing, and pretending otherwise would mark it delivered.
      return {
        ok: false,
        error: "No stored message to resend; this delivery predates request capture",
        permanent: true,
      };
    }

    // Handed back to the same queue that sends every other email, with the
    // delivery id so the outcome lands on this row rather than a new one.
    await emailQueue.push({ ...job, delivery_id: delivery!.id });

    // Queued, not sent. The email worker writes the real outcome to this row
    // when the send completes, which is why this returns ok without a response
    // code: claiming success here would overwrite the row a moment later with a
    // verdict nobody had yet reached.
    return { ok: true, response_body: "Re-queued for sending" };
  },
};

export default emailConsumer;
