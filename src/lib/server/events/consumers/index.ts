import { getConsumer, registerConsumer } from "../consumers.js";
import webhookConsumer from "./webhooks.js";
import emailConsumer from "./email.js";
import auditConsumer from "./audit.js";
import subscribersConsumer from "./subscribers.js";
import triggersConsumer from "./triggers.js";
import alertTriggerConsumer from "./alertTrigger.js";
import type { EventConsumer } from "../types.js";

// The one place that says which consumers exist.
//
// Two processes need this list and they need different things from it. The
// scheduler process needs it because it runs the relay and the dispatch worker,
// and an unregistered consumer means delivery rows nobody creates and dispatches
// that go DEAD with "no consumer registered". The web process needs it only to
// render the admin screen: which consumers there are, what mode each is in, and
// what each one is for.
//
// **Registering does not start anything.** Nothing here connects to Redis or
// takes a job; the relay and the dispatch worker are started explicitly by
// `startup.ts` and by nothing else. So the web process can safely hold the same
// registry, and the execution model stays exactly what it was: all delivery
// happens in the scheduler process, matching the dev two-process split.

/** Every consumer, in the order the admin screen lists them. */
export const ALL_CONSUMERS: readonly EventConsumer[] = [
  auditConsumer,
  webhookConsumer,
  subscribersConsumer,
  triggersConsumer,
  emailConsumer,
  alertTriggerConsumer,
];

/**
 * What each consumer is for, in an operator's words.
 *
 * Here rather than on the consumer objects because it is interface copy, and
 * putting it beside the delivery logic would invite it to drift into describing
 * the implementation instead of the effect.
 */
export const CONSUMER_DESCRIPTIONS: Record<string, string> = {
  audit: "Writes an audit log entry for every change that reaches the bus, including API and scheduler changes.",
  webhook: "Delivers signed webhooks to your configured endpoints.",
  subscribers:
    "Rehearses the incident and maintenance emails sent to status page subscribers. The existing path still sends them.",
  triggers: "Rehearses the alert notifications sent to your triggers. The existing path still sends them.",
  email: "Records subscriber emails on the delivery log and makes a failed one retryable.",
  alert_trigger: "Records alert trigger sends on the delivery log so a failed one is visible.",
};

/**
 * Registers every consumer, once.
 *
 * Idempotent, unlike `registerConsumer` itself, which throws on a duplicate name
 * so that two implementations claiming one stored `consumer` value fail at boot
 * rather than interleaving their rows. That check is worth keeping for genuine
 * mistakes, so this skips names already present instead of relaxing it.
 */
export function registerAllConsumers(): void {
  for (const consumer of ALL_CONSUMERS) {
    if (!getConsumer(consumer.name)) registerConsumer(consumer);
  }
}
