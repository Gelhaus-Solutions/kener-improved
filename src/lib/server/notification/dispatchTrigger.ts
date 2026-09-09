import sendDiscord from "./discord_notification.js";
import sendEmail from "./email_notification.js";
import sendSlack from "./slack_notification.js";
import sendWebhook from "./webhook_notification.js";
import type { TriggerMeta, TriggerRecord } from "../types/db.js";

// How to deliver one alert trigger, in one place.
//
// This four-branch dispatch used to exist twice, word for word: once in
// `alertingQueue.sendAlertNotifications` and once in the `testTrigger` admin
// action. Two copies of "how to send a trigger" is the kind of duplication that
// does not announce itself when it drifts - a header added to the webhook branch
// in one copy makes the test button send something the alert does not, and
// nothing fails. E-cut2 extracts it because a third caller was about to appear:
// the `triggers` consumer, which sends the same four kinds of message from the
// bus.
//
// **This function sends and reports. It does not decide, log, or retry.** Who to
// send to is the caller's question, a delivery row is the caller's to write, and
// retrying is the bus's job. Keeping those out means the same call is correct
// from an alert, from the retry button and from a test click, which is the whole
// reason for extracting it.

/** What one trigger send did. */
export interface TriggerDispatchResult {
  /** The message went out. False for a failure, a skip and an unsupported type alike. */
  ok: boolean;
  /** Why it did not go out, in words an operator can act on. */
  error: string | null;
  /**
   * What was sent, minus the body.
   *
   * The body is deliberately absent. Every sender substitutes `$env` secrets
   * into the URL, the headers and the body immediately before sending, so
   * capturing the real request would write credentials into `event_deliveries`,
   * into every backup of it, and onto a screen that only needs `webhooks.read`
   * to open. The `triggers` consumer's shadow row carries the rendered body with
   * those secrets left unresolved, which is the readable half of the pair.
   */
  request_headers: Record<string, string> | null;
  duration_ms: number;
  /**
   * Nothing to send, which is not a failure.
   *
   * Only an email trigger with no addresses left after trimming. The inherited
   * behaviour skipped it silently and this preserves that, but names it so a
   * caller writing a delivery row can record SKIPPED rather than inventing a
   * success.
   */
  skipped: boolean;
  /**
   * The trigger type is not one this build can deliver.
   *
   * Separated from an ordinary failure because it is permanent: retrying an
   * unknown type on the ladder for six hours cannot make it known. In
   * `alertingQueue` this used to `throw`, which aborted every trigger queued
   * behind it on the same config.
   */
  unsupported: boolean;
  /** Whatever the sender returned, for a caller that shows it to a human. */
  response: unknown;
}

/** Splits an email trigger's comma-separated `to` into real addresses. */
function addressesOf(meta: TriggerMeta): string[] {
  return (meta.to ?? "")
    .trim()
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
}

/**
 * Sends one trigger.
 *
 * Never throws. A thrown sender becomes `ok: false` with the message, because
 * every caller wants the same thing from a failure - a row saying what went
 * wrong - and the one caller that used to let it propagate did so into a
 * `for` loop, where it silently abandoned every trigger after this one.
 */
export async function dispatchTrigger(
  trigger: Pick<TriggerRecord, "trigger_type" | "trigger_meta">,
  variables: Record<string, string | number | boolean>,
): Promise<TriggerDispatchResult> {
  const started = Date.now();
  const base = { skipped: false, unsupported: false, response: null as unknown };
  const done = (r: Partial<TriggerDispatchResult>): TriggerDispatchResult => ({
    ok: false,
    error: null,
    request_headers: null,
    duration_ms: Date.now() - started,
    ...base,
    ...r,
  });

  let meta: TriggerMeta;
  try {
    meta = JSON.parse(trigger.trigger_meta ?? "") as TriggerMeta;
  } catch {
    // Unparseable configuration cannot become parseable on a retry.
    return done({ error: "Trigger configuration could not be read", unsupported: true });
  }

  try {
    switch (trigger.trigger_type) {
      case "email": {
        const to = addressesOf(meta);
        if (to.length === 0) return done({ skipped: true, error: "No recipient addresses configured" });
        const response = await sendEmail(meta.email_body, meta.email_subject, variables, to, meta.from);
        return done({ ok: true, request_headers: { to: to.join(", ") }, response });
      }
      case "webhook": {
        const response = await sendWebhook(meta.webhook_body, variables, meta.url, JSON.stringify(meta.headers));
        // Every HTTP sender reports failure by *returning* `{ error }` rather
        // than by throwing, so a try/catch on its own would record each one as a
        // success. This line is why a dead Slack webhook is visible at all.
        const error = response?.error ?? null;
        return done({ ok: !error, error, request_headers: { url: meta.url }, response });
      }
      case "discord": {
        const response = await sendDiscord(meta.discord_body, variables, meta.url);
        const error = response?.error ?? null;
        return done({ ok: !error, error, request_headers: { url: meta.url }, response });
      }
      case "slack": {
        const response = await sendSlack(meta.slack_body, variables, meta.url);
        const error = response?.error ?? null;
        return done({ ok: !error, error, request_headers: { url: meta.url }, response });
      }
      default:
        return done({ error: `Unsupported trigger type "${trigger.trigger_type}"`, unsupported: true });
    }
  } catch (error) {
    return done({ error: error instanceof Error ? error.message : String(error) });
  }
}

export default dispatchTrigger;
