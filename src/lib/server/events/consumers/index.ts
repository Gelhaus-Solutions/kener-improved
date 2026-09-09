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
 * Consumers whose old send path is still running, so `live` would double-send.
 *
 * The event consumers screen refuses to set one of these live, and that refusal
 * is the only thing standing between a click and every customer receiving two of
 * every notification. Membership here is not a property of the consumer, it is a
 * property of the *other* code: a consumer leaves this set in the same commit
 * that teaches its legacy caller to stand down.
 *
 * `subscribers` left in E-cut1, when `subscriberQueue.push` learned to return
 * without doing anything once the consumer is live, and `triggers` left in
 * E-cut2, when `sendAlertNotifications` learned the same. Empty is the correct
 * end state rather than a sign this is unused: it stays because the next channel
 * moved onto the bus needs it, and a consumer added without a thought about its
 * flip is a consumer whose flip nobody thought about.
 *
 * Deliberately a named set rather than the old test, which was
 * `declared mode === "shadow"`. That test conflated two unrelated things: what
 * the code ships as a safe default, and whether a second sender exists. They
 * were the same answer until the cutover and they are not the same question, so
 * once one consumer was cut over the old test would have gone on refusing a flip
 * that is now perfectly safe.
 */
export const UNCUT_CONSUMERS: ReadonlySet<string> = new Set<string>();

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
    "Sends the incident and maintenance emails your status page subscribers receive. In shadow it only rehearses them and the older path keeps sending.",
  triggers:
    "Sends the alert notifications your triggers deliver, each with its own retries. In shadow it only rehearses them and the older path keeps sending.",
  email: "Retries subscriber emails sent before the notification cutover.",
  alert_trigger: "Retries alert notifications sent before the notification cutover.",
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
