import type { EventType } from "$lib/event-taxonomy.js";

// Shapes for the event bus. Kept separate from types/db.ts because the delivery
// side is a protocol between the relay and its consumers, not just table rows.

/** Who caused an event. Mirrors audit_log's actor vocabulary deliberately. */
export type EventActorType = "user" | "api_key" | "system" | "oidc" | "anonymous";

/**
 * Where a delivery is in its life.
 *
 * PENDING    created, waiting for a dispatch attempt
 * IN_FLIGHT  a worker holds it right now
 * DELIVERED  the consumer accepted it
 * FAILED     the attempt failed and next_attempt_at says when to retry
 * DEAD       the retry ladder is exhausted; retryable only by hand
 * SKIPPED    the consumer looked at it and declined (filtered out, disabled)
 * SHADOW     computed but deliberately not acted on (the P6 cutover mode)
 */
export type DeliveryStatus = "PENDING" | "IN_FLIGHT" | "DELIVERED" | "FAILED" | "DEAD" | "SKIPPED" | "SHADOW";

/** What a caller hands to emit(). */
export interface EventInput {
  /**
   * Mandatory, and never defaulted anywhere in this file or its callers.
   *
   * A default here would be the single most expensive line in the codebase: P4
   * turns org_id into the tenant boundary, and every call site that quietly took
   * the default would become a cross-tenant leak that no type checker could
   * find. Requiring it now means P4 gets a list of compile errors instead.
   */
  org_id: number;

  /**
   * One of the closed set in `$lib/event-taxonomy`. Typed rather than a free
   * string so a typo is a compile error instead of an event nobody subscribes to.
   */
  type: EventType;

  /**
   * What the event is about. Defaults from `EVENT_AGGREGATE_TYPE`, so pass it
   * only to override; `aggregate_id` is what callers actually need to supply.
   */
  aggregate_type?: string | null;
  aggregate_id?: string | number | null;

  /**
   * Who caused it. Optional: when omitted it comes from the ambient
   * `eventContext`, which the request pipeline and the queue workers establish.
   * Pass it only when the ambient actor is not the right answer.
   */
  actor_type?: EventActorType;
  actor_id?: string | number | null;
  actor_label?: string | null;

  /** UTC seconds. Defaults to now, but pass it for backfilled history. */
  occurred_at?: number;

  payload?: unknown;
  /** A shallow before/after, already redacted by the caller. */
  diff?: unknown;

  /** Defaults to the ambient request id, tying an event to its audit rows. */
  correlation_id?: string | null;
  causation_id?: string | null;

  /**
   * Set this when the same event can legitimately be emitted twice: a retried
   * job, a webhook that fires on every poll. A repeated emit with the same key
   * is silently dropped. Leave it unset when the event is naturally unique.
   */
  idempotency_key?: string | null;

  /** Record it, never deliver it. For bulk imports and replays. */
  suppress?: boolean;

  schema_version?: number;
}

/** A row of event_outbox, as consumers see it. */
export interface OutboxEvent {
  id: number;
  event_id: string;
  org_id: number;
  type: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  occurred_at: number;
  payload: string | null;
  diff: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  idempotency_key: string | null;
  suppress: boolean;
  schema_version: number;
  claimed_at: number | null;
  claimed_by: string | null;
  published_at: number | null;
}

export interface EventDeliveryInsert {
  event_id: string;
  org_id: number;
  consumer: string;
  target_type: string;
  target_id: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  response_code: number | null;
  response_body: string | null;
  error: string | null;
  /** Redacted before storage. What was sent, so a failure can be explained. */
  request_headers?: string | null;
  /**
   * The request body.
   *
   * Also the retry mechanism for channels that cannot rebuild their own message:
   * a webhook can be regenerated from the event, a rendered subscriber email
   * cannot.
   */
  request_body?: string | null;
  duration_ms?: number | null;
  created_at: number;
  updated_at: number;
}

export interface EventDeliveryRecord extends EventDeliveryInsert {
  id: number;
}

export interface EventDeliveryFilter {
  org_id?: number;
  consumer?: string;
  status?: DeliveryStatus;
  event_id?: string;
  target_type?: string;
  target_id?: string;
  start?: number;
  end?: number;
}

/**
 * One place a consumer wants an event delivered to.
 *
 * Both fields are strings and neither is optional, because the UNIQUE index that
 * collapses duplicate deliveries includes them and a NULL in a UNIQUE index does
 * not deduplicate. A consumer with no meaningful target uses "" for both, which
 * gives it exactly one delivery row per event.
 */
export interface DeliveryTarget {
  target_type: string;
  target_id: string;
}

/** The outcome of one delivery attempt. */
export interface DeliveryResult {
  ok: boolean;
  response_code?: number | null;
  response_body?: string | null;
  error?: string | null;
  /** What was sent. Recorded on the row so the delivery log can explain the failure. */
  request_headers?: Record<string, string> | null;
  request_body?: string | null;
  duration_ms?: number | null;
  /**
   * True when retrying cannot possibly help: a 400 from a webhook, a subscriber
   * that no longer exists. Sends the delivery straight to DEAD instead of
   * spending six hours of ladder on a certain failure.
   */
  permanent?: boolean;
}

/**
 * What a consumer is allowed to do right now. See events/consumerModes.ts for
 * why there are four of these and what each one is for.
 */
export type ConsumerMode = "off" | "legacy" | "shadow" | "live";

/** Options for one delivery attempt. */
export interface DeliveryOptions {
  /**
   * Build everything, send nothing.
   *
   * A consumer that sets `supportsDryRun` must, when this is true, do every
   * lookup and every render it would do for a real send and then return the
   * request it *would* have made without performing any outbound I/O. That
   * recorded request is the whole value of a shadow period: comparing recipient
   * lists catches a broken filter, but only comparing rendered bodies catches a
   * template variable that silently stopped resolving.
   */
  dryRun?: boolean;
}

/**
 * A consumer of the bus.
 *
 * A consumer declares what it wants and how to deliver it; whether it is
 * actually allowed to deliver is an operator's decision, read per event from
 * `site_data`. That split is what lets a channel be moved onto the bus and moved
 * back off it without touching this file.
 */
export interface EventConsumer {
  /** Stable identifier, stored in event_deliveries.consumer. Never rename it. */
  name: string;

  /**
   * The mode this consumer runs in when `site_data.eventBusConsumers` says
   * nothing about it: on a fresh install, or after this consumer is added to a
   * build whose flag row predates it.
   *
   * **The effective mode is not this field.** Read it with
   * `effectiveMode(consumer)`, never directly: the operator's setting wins, and
   * code that reads `mode` straight off the object is code that ignores the
   * switch the whole strangler design rests on.
   */
  mode: ConsumerMode;

  /**
   * True when `deliver()` honours `dryRun`.
   *
   * Opt-in rather than assumed, and the asymmetry is on purpose: a consumer that
   * ignored the flag would send a real notification during what an operator was
   * told is a rehearsal. The default has to be the one that cannot do that, so a
   * shadow consumer without this records its resolved targets and never runs
   * `deliver()` at all.
   */
  supportsDryRun?: boolean;

  /**
   * Per-aggregate FIFO. Costs a Redis lock per delivery, so it is opt-in.
   *
   * True for consumers where order is meaning (audit, page status). False for
   * fan-out, where it would be actively harmful: one slow webhook endpoint must
   * never head-of-line-block a different customer's endpoint. Unordered
   * consumers get `seq` in the payload so a receiver can order for itself.
   */
  ordered?: boolean;

  /** Which events this consumer wants, and where each one goes. */
  targets(event: OutboxEvent): Promise<DeliveryTarget[]> | DeliveryTarget[];

  /** One attempt. Throwing is treated as a retryable failure. */
  deliver(event: OutboxEvent, target: DeliveryTarget, options?: DeliveryOptions): Promise<DeliveryResult>;
}
