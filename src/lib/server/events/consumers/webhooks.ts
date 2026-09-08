import db from "../../db/db.js";
import { emit } from "../emit.js";
import { serializeAggregate } from "../serializers/index.js";
import { sendWebhook, AUTO_DISABLE_AFTER_FAILURES, type WebhookEnvelope } from "../../notification/webhook_delivery.js";
import { isAdminEventType } from "$lib/event-taxonomy.js";
import type { EventConsumer, OutboxEvent, DeliveryTarget, DeliveryResult } from "../types.js";

// Outbound webhooks as a consumer of the event bus.
//
// This is the first thing registered on the bus, and it was chosen to be first
// because it is purely additive: nothing depends on it today, so if the bus
// misbehaves the worst outcome is a webhook nobody had yet. Proving the whole
// path on something with no regression surface is the point.
//
// Unordered, deliberately. Delivery to one customer's endpoint must never wait
// on delivery to another's, and a slow or dead receiver would head-of-line-block
// everyone behind it if this were `ordered`. Receivers order for themselves
// using `seq`, which the envelope carries for exactly that reason.

const CONSUMER_NAME = "webhook";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Builds the envelope a receiver sees.
 *
 * `data.object` is the object's *current* state from the serializer, not a
 * snapshot taken when the event was emitted. That is a real tradeoff: a delivery
 * retried six hours later carries the object as it is now, which can differ from
 * what the event described. It is the right side of the tradeoff because the
 * common failure a receiver has to survive is missing an update, and current
 * state lets it re-converge; a stale snapshot would have it write yesterday's
 * values over today's. `diff` and `data.previous` still say what the event
 * itself changed.
 */
async function buildEnvelope(event: OutboxEvent, apiVersion: string): Promise<WebhookEnvelope> {
  const diff = parseJson(event.diff);
  const object = await serializeAggregate(event.aggregate_type, event.aggregate_id);

  return {
    id: event.event_id,
    type: event.type,
    api_version: apiVersion,
    occurred_at: event.occurred_at,
    // The outbox's own id: a total, durable publish order across the instance.
    seq: event.id,
    data: {
      // Falls back to the stored payload when there is no serializer or the
      // object is gone, which is the normal case for a `*.deleted` event.
      object: object ?? parseJson(event.payload),
      previous: (diff?.before as Record<string, unknown>) ?? null,
    },
    diff,
  };
}

export const webhookConsumer: EventConsumer = {
  name: CONSUMER_NAME,
  mode: "live",
  ordered: false,

  /** Every active endpoint subscribed to this event type, exactly or by wildcard. */
  async targets(event: OutboxEvent): Promise<DeliveryTarget[]> {
    // Administrative events describe the instance's own configuration - who was
    // given which permission, which API key was created. They are for the audit
    // trail, and a third-party endpoint has no business receiving them. The
    // taxonomy marks them and the subscription UI never offers them; this is the
    // check that holds even if a row is written by hand.
    if (isAdminEventType(event.type)) return [];

    const endpoints = await db.getActiveWebhookEndpointsForEvent(event.org_id, event.type);
    return endpoints.map((e) => ({ target_type: "endpoint", target_id: String(e.id) }));
  },

  async deliver(event: OutboxEvent, target: DeliveryTarget): Promise<DeliveryResult> {
    const endpoint = await db.getWebhookEndpointById(Number(target.target_id));
    if (!endpoint) {
      // Deleted between the relay creating the delivery row and now. Nothing to
      // retry towards.
      return { ok: false, error: "Endpoint no longer exists", permanent: true };
    }
    if (endpoint.status !== "ACTIVE") {
      return { ok: false, error: `Endpoint is ${endpoint.status}`, permanent: true };
    }

    const now = nowSeconds();
    const envelope = await buildEnvelope(event, endpoint.api_version);
    const result = await sendWebhook(endpoint, envelope, now);

    // Health is tracked per endpoint, not per delivery: one failed delivery is
    // noise, twenty in a row is an endpoint that has gone away.
    const failures = await db.recordWebhookEndpointOutcome(endpoint.id, result.ok, now);

    if (!result.ok && failures >= AUTO_DISABLE_AFTER_FAILURES) {
      // Conditional on it still being ACTIVE, so two workers crossing the
      // threshold together disable it once and announce it once.
      if (await db.autoDisableWebhookEndpoint(endpoint.id, now)) {
        console.error(
          `webhook: endpoint ${endpoint.id} (${endpoint.name}) auto-disabled after ${failures} consecutive failures`,
        );
        await emit({
          org_id: endpoint.org_id,
          type: "webhook_endpoint.disabled",
          aggregate_id: endpoint.id,
          actor_type: "system",
          // One announcement per disabling, not per subsequent failed delivery.
          idempotency_key: `webhook_endpoint.disabled:${endpoint.id}:${now}`,
          payload: {
            endpoint_id: endpoint.id,
            name: endpoint.name,
            consecutive_failures: failures,
            last_error: result.error,
          },
        });
      }
    }

    return {
      ok: result.ok,
      response_code: result.status,
      response_body: result.body,
      error: result.error,
      permanent: result.permanent,
      request_headers: result.request_headers,
      request_body: result.request_body,
      duration_ms: result.duration_ms,
    };
  },
};

export default webhookConsumer;
