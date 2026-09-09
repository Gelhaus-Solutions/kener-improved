import triggersConsumer from "./triggers.js";
import type { EventConsumer, OutboxEvent, DeliveryTarget, DeliveryResult, DeliveryOptions } from "../types.js";

// Alert triggers, as far as the delivery log is concerned.
//
// The same shape as `consumers/email.ts` and for the same two reasons.
//
// **It routes nothing.** `targets()` returns an empty list, so the relay never
// sends an event here. Rows under this name are written by `alertingQueue` as it
// fires triggers inline - which it does only while the `triggers` consumer is
// not live. That was worth having on its own: `notifyQuietly` swallows every
// trigger failure by design, so before the delivery log a Slack webhook that had
// been 404ing for a month produced one console line per alert and nothing an
// operator could ever find.
//
// **It was also the live half of the H8c shadow diff.** The `triggers` consumer
// rehearsed what it would send and recorded a SHADOW row keyed on the same event
// and the same trigger id; this is what the rehearsal was compared against.
// Without a row from the old path the diff would have had a rehearsal on one
// side and nothing on the other, which cannot distinguish "the old path sent
// nothing" from "the old path never recorded what it sent".
//
// **After the cutover it serves history, and stays registered for that reason.**
// Once `triggers` is live no new rows are written under this name, but every row
// written before the flip still carries it, and deregistering would turn each
// one's retry button into "no consumer registered as alert_trigger".
//
// A separate consumer name from `triggers` is not cosmetic: the UNIQUE that
// deduplicates deliveries is `(event_id, consumer, target_type, target_id)`, and
// the rehearsal and the real send agree on three of those four. Sharing the name
// would make one silently overwrite the other and there would be no diff at all.

export const ALERT_TRIGGER_CONSUMER = "alert_trigger";

export const alertTriggerConsumer: EventConsumer = {
  name: ALERT_TRIGGER_CONSUMER,
  mode: "live",
  ordered: false,
  supportsDryRun: false,

  // See the file header: the relay must not route here. Rows under this name are
  // written by alertingQueue as it sends.
  targets(): DeliveryTarget[] {
    return [];
  },

  /**
   * Replays one historical trigger send.
   *
   * Rows under this name are written by `alertingQueue` as it sends, so every
   * one of them predates the cutover. The retry button on the delivery log used
   * to refuse them, because resending meant the bus performing an outbound alert
   * notification and that was exactly what the shadow period existed to
   * postpone. E-cut2 removed the reason: the bus now sends triggers as its
   * ordinary business, so a retry here is the same call the `triggers` consumer
   * makes.
   *
   * Delegates to `triggers` rather than duplicating it. Rebuilding the alert,
   * the config and the variables is a dozen lines that would then have to stay
   * in step with the consumer that does it for real, and this is a retry path
   * that runs rarely enough that nobody would notice it drifting.
   */
  async deliver(event: OutboxEvent, target: DeliveryTarget, options?: DeliveryOptions): Promise<DeliveryResult> {
    return await triggersConsumer.deliver(event, target, options);
  },
};

export default alertTriggerConsumer;
