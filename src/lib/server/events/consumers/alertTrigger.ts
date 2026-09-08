import type { EventConsumer, OutboxEvent, DeliveryTarget, DeliveryResult } from "../types.js";

// Alert triggers, as far as the delivery log is concerned.
//
// The same shape as `consumers/email.ts` and for the same two reasons.
//
// **It routes nothing.** `targets()` returns an empty list, so the relay never
// sends an event here. `alertingQueue` still fires triggers inline the way it
// always has, and now writes an `event_deliveries` row per trigger as it does
// so. That is worth having on its own: `notifyQuietly` swallows every trigger
// failure by design, so until now a Slack webhook that had been 404ing for a
// month produced one console line per alert and nothing an operator could ever
// find. Those failures are now rows on the delivery log beside every other
// channel.
//
// **It is also the live half of the H8c shadow diff.** The `triggers` consumer
// rehearses what it would send and records a SHADOW row keyed on the same event
// and the same trigger id; this is what the rehearsal gets compared against.
// Without a row from the old path the diff would have a rehearsal on one side
// and nothing on the other, which cannot distinguish "the old path sent nothing"
// from "the old path never recorded what it sent".
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

  async deliver(_event: OutboxEvent, target: DeliveryTarget): Promise<DeliveryResult> {
    // Registered so a failed trigger is a visible row rather than a dead
    // reference, but a resend is genuinely not available yet: re-sending means
    // the bus performing an outbound alert notification, which is exactly the
    // behaviour the shadow period exists to postpone. P6 turns the `triggers`
    // consumer live and this becomes a real replay.
    return {
      ok: false,
      error: `Resending trigger ${target.target_id} is not available until the P6 notification cutover; the trigger can be re-tested from the triggers screen`,
      permanent: true,
    };
  },
};

export default alertTriggerConsumer;
