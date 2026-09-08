import { BaseRepository, type CountResult } from "./base.js";
import { dialectOf } from "../capabilities.js";
import type {
  OutboxEvent,
  EventDeliveryInsert,
  EventDeliveryRecord,
  EventDeliveryFilter,
  DeliveryStatus,
} from "../../events/types.js";

export interface OutboxInsert {
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
}

export interface OutboxFilter {
  org_id?: number;
  type?: string;
  aggregate_type?: string;
  aggregate_id?: string;
  start?: number;
  end?: number;
}

/**
 * The event outbox and its delivery attempts.
 *
 * The interesting method here is `claimUnpublished`. Everything else is CRUD.
 */
export class EventsRepository extends BaseRepository {
  // ---------------------------------------------------------------- outbox

  /**
   * Appends one event.
   *
   * Returns the `event_id` that now represents this fact, and whether this call
   * is the one that wrote it. On a collision the stored id is returned rather
   * than the caller's, so a caller that wants to reference the event afterwards
   * references the real one instead of an id that was thrown away.
   *
   * The collision is detected by reading the key back rather than by inspecting
   * what the insert returned, because no dialect reports this usefully:
   * better-sqlite3 hands back the *previous* `lastInsertRowid` for a suppressed
   * insert, which is indistinguishable from a successful one. Verified against
   * this repo's knex 3.1 and better-sqlite3 12.6. The extra round trip is paid
   * only by callers that set a key, which is the deduplicating path and not the
   * hot one.
   *
   * Note there is no `updateEvent` and no `deleteEvent`. An outbox row is a
   * statement that something happened; editing one after the fact would make
   * every consumer's view of history depend on when it happened to read.
   * Retention goes through `pruneEvents`, which can only express "older than".
   */
  async insertEvent(row: OutboxInsert): Promise<{ inserted: boolean; event_id: string }> {
    if (!row.idempotency_key) {
      // event_id is a fresh ULID, so a conflict here is a bug worth surfacing
      // rather than swallowing. No conflict clause, on purpose.
      await this.knex("event_outbox").insert(row);
      return { inserted: true, event_id: row.event_id };
    }

    await this.knex("event_outbox").insert(row).onConflict("idempotency_key").ignore();
    const stored = (await this.knex("event_outbox")
      .select("event_id")
      .where("idempotency_key", row.idempotency_key)
      .first()) as { event_id: string } | undefined;

    // The row is guaranteed present: either this insert wrote it or an earlier
    // one did. A missing row would mean the key was pruned between the two
    // statements, which retention cannot do to an unpublished event.
    const eventId = stored?.event_id ?? row.event_id;
    return { inserted: eventId === row.event_id, event_id: eventId };
  }

  /**
   * Takes ownership of up to `limit` unpublished events.
   *
   * Split by dialect, because the two mechanisms are genuinely different rather
   * than one being a fallback for the other:
   *
   * **Postgres** uses `FOR UPDATE SKIP LOCKED`, which lets several relays scan
   * the same rows concurrently and each walk away with a disjoint set, in one
   * statement.
   *
   * **Everything else** uses a claim token. better-sqlite3 is synchronous and
   * has no `SKIP LOCKED`, so exclusion comes from the UPDATE itself: the
   * `claimed_at IS NULL OR claimed_at < expiry` predicate means the second relay
   * to run finds nothing left to claim. Reading back by token is what makes this
   * safe rather than merely likely, since a token is generated per call and only
   * the winner's rows carry it.
   *
   * The claim expires, which is the whole point: a relay killed between claiming
   * and publishing has its work picked up by the next run rather than stranding
   * it. That is also why the relay must tolerate publishing an event twice; see
   * the UNIQUE on event_deliveries.
   */
  async claimUnpublished(
    limit: number,
    claimToken: string,
    now: number,
    claimTtlSeconds: number,
  ): Promise<OutboxEvent[]> {
    const expiredBefore = now - claimTtlSeconds;

    if (dialectOf(this.knex) === "postgresql") {
      const result = await this.knex.raw(
        `update event_outbox
            set claimed_at = ?, claimed_by = ?
          where id in (
            select id from event_outbox
             where published_at is null
               and (claimed_at is null or claimed_at < ?)
             order by id
             limit ?
               for update skip locked
          )
        returning *`,
        [now, claimToken, expiredBefore, limit],
      );
      const rows = (result?.rows ?? []) as Record<string, unknown>[];
      return rows.map((r) => this.mapEvent(r)).sort((a, b) => a.id - b.id);
    }

    // Two statements rather than `update ... where id in (subquery on the same
    // table)`, which MySQL rejects outright (error 1093). Selecting the ids
    // first sidesteps that and costs one extra round trip on a path that runs
    // once a second.
    const candidates = (await this.knex("event_outbox")
      .select("id")
      .whereNull("published_at")
      .andWhere((qb) => qb.whereNull("claimed_at").orWhere("claimed_at", "<", expiredBefore))
      .orderBy("id", "asc")
      .limit(limit)) as { id: number }[];
    if (candidates.length === 0) return [];

    await this.knex("event_outbox")
      .whereIn(
        "id",
        candidates.map((c) => c.id),
      )
      .whereNull("published_at")
      .andWhere((qb) => qb.whereNull("claimed_at").orWhere("claimed_at", "<", expiredBefore))
      .update({ claimed_at: now, claimed_by: claimToken });

    const rows = (await this.knex("event_outbox")
      .select("*")
      .where("claimed_by", claimToken)
      .whereNull("published_at")
      .orderBy("id", "asc")) as Record<string, unknown>[];
    return rows.map((r) => this.mapEvent(r));
  }

  /** Marks claimed events as published. The last step of a relay pass. */
  async markPublished(eventIds: string[], now: number): Promise<void> {
    if (eventIds.length === 0) return;
    await this.knex("event_outbox").whereIn("event_id", eventIds).update({ published_at: now, claimed_at: null });
  }

  async getEventByEventId(eventId: string): Promise<OutboxEvent | undefined> {
    const row = await this.knex("event_outbox").select("*").where("event_id", eventId).first();
    return row ? this.mapEvent(row as Record<string, unknown>) : undefined;
  }

  async getEventsPaginated(filter: OutboxFilter, page: number, limit: number): Promise<OutboxEvent[]> {
    const rows = (await this.applyOutboxFilter(this.knex("event_outbox").select("*"), filter)
      .orderBy("id", "desc")
      .limit(limit)
      .offset((page - 1) * limit)) as Record<string, unknown>[];
    return rows.map((r) => this.mapEvent(r));
  }

  async getEventsCount(filter: OutboxFilter): Promise<CountResult | undefined> {
    return await this.applyOutboxFilter(this.knex("event_outbox").count("* as count"), filter).first<CountResult>();
  }

  /** Unpublished rows, for a health check. A number that only ever grows is an alert. */
  async getUnpublishedCount(): Promise<number> {
    const row = await this.knex("event_outbox").whereNull("published_at").count("* as count").first<CountResult>();
    return Number(row?.count ?? 0);
  }

  /**
   * Deletes published events older than `cutoffTs`.
   *
   * Unpublished rows are never pruned regardless of age: an event old enough to
   * expire that still has not been delivered is the exact thing an operator
   * needs to see, and deleting it would hide the outage that caused it.
   */
  async pruneEvents(cutoffTs: number): Promise<number> {
    return await this.knex("event_outbox").where("occurred_at", "<", cutoffTs).whereNotNull("published_at").del();
  }

  // ------------------------------------------------------------ deliveries

  /**
   * Creates delivery rows, ignoring any that already exist.
   *
   * The conflict is expected, not exceptional: a relay that died after inserting
   * deliveries but before marking the event published will insert them again on
   * the next pass. Collapsing here is what makes that crash harmless.
   */
  async insertDeliveries(rows: EventDeliveryInsert[]): Promise<void> {
    if (rows.length === 0) return;
    // Chunked because SQLite caps bound variables per statement and one event
    // can fan out to a lot of webhook endpoints.
    for (let i = 0; i < rows.length; i += 100) {
      await this.knex("event_deliveries")
        .insert(rows.slice(i, i + 100))
        .onConflict(["event_id", "consumer", "target_type", "target_id"])
        .ignore();
    }
  }

  /**
   * Deliveries owed another attempt: never started, or failed and now due.
   *
   * IN_FLIGHT is excluded on purpose. A delivery genuinely stuck in IN_FLIGHT
   * because its worker was killed is recovered by `reviveStuckDeliveries`, which
   * needs an explicit age threshold; sweeping it back here on a 60s timer would
   * double-send everything that merely takes longer than a minute to deliver.
   */
  async getDueDeliveries(now: number, limit: number): Promise<EventDeliveryRecord[]> {
    const rows = (await this.knex("event_deliveries")
      .select("*")
      .whereIn("status", ["PENDING", "FAILED"])
      .andWhere((qb) => qb.whereNull("next_attempt_at").orWhere("next_attempt_at", "<=", now))
      .orderBy("id", "asc")
      .limit(limit)) as Record<string, unknown>[];
    return rows.map((r) => this.mapDelivery(r));
  }

  /**
   * Moves a delivery to IN_FLIGHT, but only from a state it may leave.
   *
   * Returns false when another worker got there first. This is the guard that
   * makes a duplicate BullMQ job (from a re-published event, or a jobId that had
   * already been evicted) a no-op instead of a second HTTP request to somebody's
   * endpoint.
   */
  async beginDeliveryAttempt(id: number, now: number): Promise<boolean> {
    const updated = await this.knex("event_deliveries")
      .where("id", id)
      .whereIn("status", ["PENDING", "FAILED"])
      .update({ status: "IN_FLIGHT", last_attempt_at: now, updated_at: now })
      .then((n) => Number(n));
    return updated > 0;
  }

  async completeDeliveryAttempt(
    id: number,
    fields: {
      status: DeliveryStatus;
      attempts: number;
      next_attempt_at: number | null;
      response_code: number | null;
      response_body: string | null;
      error: string | null;
      request_headers?: string | null;
      request_body?: string | null;
      duration_ms?: number | null;
      updated_at: number;
    },
  ): Promise<void> {
    await this.knex("event_deliveries").where("id", id).update(fields);
  }

  /**
   * Every delivery for one target that ended up DEAD, oldest first.
   *
   * Backs the "retry everything this endpoint missed" action: after a receiver
   * has been down for a day, retrying its dead letters one row at a time is not
   * a workable operator experience.
   */
  async getDeadDeliveriesForTarget(
    orgId: number,
    consumer: string,
    targetType: string,
    targetId: string,
    limit: number,
  ): Promise<EventDeliveryRecord[]> {
    const rows = (await this.knex("event_deliveries")
      .select("*")
      .where("org_id", orgId)
      .andWhere("consumer", consumer)
      .andWhere("target_type", targetType)
      .andWhere("target_id", targetId)
      .andWhere("status", "DEAD")
      .orderBy("id", "asc")
      .limit(limit)) as Record<string, unknown>[];
    return rows.map((r) => this.mapDelivery(r));
  }

  /** Distinct consumers that have ever delivered, for the log's filter dropdown. */
  async getDeliveryConsumers(orgId: number): Promise<string[]> {
    const rows = (await this.knex("event_deliveries")
      .distinct("consumer")
      .where("org_id", orgId)
      .orderBy("consumer", "asc")) as { consumer: string }[];
    return rows.map((r) => r.consumer);
  }

  /** Records a delivery that was never attempted, e.g. a shadow-mode consumer. */
  async setDeliveryStatus(id: number, status: DeliveryStatus, now: number): Promise<void> {
    await this.knex("event_deliveries").where("id", id).update({ status, updated_at: now });
  }

  /**
   * Returns IN_FLIGHT deliveries whose worker plainly died, back to FAILED so
   * the sweeper can pick them up.
   *
   * `olderThan` should be comfortably longer than the slowest legitimate
   * delivery, because the cost of getting it wrong is a duplicate webhook.
   */
  async reviveStuckDeliveries(olderThan: number, now: number): Promise<number> {
    return await this.knex("event_deliveries")
      .where("status", "IN_FLIGHT")
      .andWhere("last_attempt_at", "<", olderThan)
      .update({ status: "FAILED", next_attempt_at: now, updated_at: now })
      .then((n) => Number(n));
  }

  /**
   * Deliveries for these events that still need dispatching.
   *
   * The relay needs delivery ids to enqueue with, and `insertDeliveries` cannot
   * return them (some rows were suppressed by the conflict clause, and the
   * dialects disagree on what an ignored insert returns). Reading back is also
   * what makes a re-published event safe: rows that already reached DELIVERED on
   * the first pass are simply not in this result and are never enqueued twice.
   */
  async getPendingDeliveriesForEvents(eventIds: string[]): Promise<EventDeliveryRecord[]> {
    if (eventIds.length === 0) return [];
    const rows = (await this.knex("event_deliveries")
      .select("*")
      .whereIn("event_id", eventIds)
      .where("status", "PENDING")
      .orderBy("id", "asc")) as Record<string, unknown>[];
    return rows.map((r) => this.mapDelivery(r));
  }

  /**
   * True when an `ordered` consumer still owes a delivery for an *earlier* event
   * on the same aggregate.
   *
   * This is the seq guard. The Redis lock around an ordered delivery gives
   * mutual exclusion, which stops two attempts running at once but says nothing
   * about which of two waiting events goes first. This query is what turns that
   * into actual FIFO: event 7 does not go out while event 5 for the same
   * incident is still pending.
   *
   * Joined against event_outbox because ordering is defined by `event_outbox.id`
   * and nothing else. The delivery row's own id is insertion order, which the
   * relay can produce out of sequence when a claim is retried.
   */
  async hasEarlierIncompleteDelivery(
    consumer: string,
    aggregateType: string,
    aggregateId: string,
    outboxId: number,
  ): Promise<boolean> {
    const row = await this.knex("event_deliveries as d")
      .join("event_outbox as e", "e.event_id", "d.event_id")
      .select("d.id")
      .where("d.consumer", consumer)
      .andWhere("e.aggregate_type", aggregateType)
      .andWhere("e.aggregate_id", aggregateId)
      .andWhere("e.id", "<", outboxId)
      .whereIn("d.status", ["PENDING", "FAILED", "IN_FLIGHT"])
      .first();
    return row !== undefined;
  }

  async getDeliveryById(id: number): Promise<EventDeliveryRecord | undefined> {
    const row = await this.knex("event_deliveries").select("*").where("id", id).first();
    return row ? this.mapDelivery(row as Record<string, unknown>) : undefined;
  }

  async getDeliveriesByEventId(eventId: string): Promise<EventDeliveryRecord[]> {
    const rows = (await this.knex("event_deliveries")
      .select("*")
      .where("event_id", eventId)
      .orderBy("id", "asc")) as Record<string, unknown>[];
    return rows.map((r) => this.mapDelivery(r));
  }

  async getDeliveriesPaginated(
    filter: EventDeliveryFilter,
    page: number,
    limit: number,
  ): Promise<EventDeliveryRecord[]> {
    const rows = (await this.applyDeliveryFilter(this.knex("event_deliveries").select("*"), filter)
      .orderBy("id", "desc")
      .limit(limit)
      .offset((page - 1) * limit)) as Record<string, unknown>[];
    return rows.map((r) => this.mapDelivery(r));
  }

  async getDeliveriesCount(filter: EventDeliveryFilter): Promise<CountResult | undefined> {
    return await this.applyDeliveryFilter(
      this.knex("event_deliveries").count("* as count"),
      filter,
    ).first<CountResult>();
  }

  /**
   * Puts a DEAD delivery back on the ladder from the start. The manual retry
   * behind E9's dead-letter screen.
   */
  async resetDeliveryForRetry(id: number, now: number): Promise<boolean> {
    const updated = await this.knex("event_deliveries")
      .where("id", id)
      .where("status", "DEAD")
      .update({ status: "PENDING", attempts: 0, next_attempt_at: now, error: null, updated_at: now })
      .then((n) => Number(n));
    return updated > 0;
  }

  async pruneDeliveries(cutoffTs: number): Promise<number> {
    // DEAD rows survive retention: they are the record of what never reached its
    // destination, and that is worth more than the bytes it costs.
    return await this.knex("event_deliveries").where("created_at", "<", cutoffTs).whereNot("status", "DEAD").del();
  }

  // ---------------------------------------------------------------- mapping

  /**
   * SQLite has no boolean type and hands back 0 or 1; Postgres hands back a real
   * boolean. Normalising here means no consumer has to know which database it is
   * talking to in order to read `suppress` correctly.
   */
  private mapEvent(row: Record<string, unknown>): OutboxEvent {
    return {
      ...(row as unknown as OutboxEvent),
      id: Number(row.id),
      org_id: Number(row.org_id),
      occurred_at: Number(row.occurred_at),
      schema_version: Number(row.schema_version),
      suppress: row.suppress === true || row.suppress === 1 || row.suppress === "1",
      claimed_at: row.claimed_at === null || row.claimed_at === undefined ? null : Number(row.claimed_at),
      published_at: row.published_at === null || row.published_at === undefined ? null : Number(row.published_at),
    };
  }

  private mapDelivery(row: Record<string, unknown>): EventDeliveryRecord {
    return {
      ...(row as unknown as EventDeliveryRecord),
      id: Number(row.id),
      org_id: Number(row.org_id),
      attempts: Number(row.attempts),
      duration_ms: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  private applyOutboxFilter<T extends { where: (...args: never[]) => T }>(query: T, filter: OutboxFilter): T {
    let q = query as unknown as { andWhere: (...args: unknown[]) => typeof q };
    if (filter.org_id !== undefined) q = q.andWhere("org_id", filter.org_id);
    if (filter.type !== undefined) q = q.andWhere("type", filter.type);
    if (filter.aggregate_type !== undefined) q = q.andWhere("aggregate_type", filter.aggregate_type);
    if (filter.aggregate_id !== undefined) q = q.andWhere("aggregate_id", filter.aggregate_id);
    if (filter.start !== undefined) q = q.andWhere("occurred_at", ">=", filter.start);
    if (filter.end !== undefined) q = q.andWhere("occurred_at", "<", filter.end);
    return q as unknown as T;
  }

  private applyDeliveryFilter<T extends { where: (...args: never[]) => T }>(query: T, filter: EventDeliveryFilter): T {
    let q = query as unknown as { andWhere: (...args: unknown[]) => typeof q };
    if (filter.org_id !== undefined) q = q.andWhere("org_id", filter.org_id);
    if (filter.consumer !== undefined) q = q.andWhere("consumer", filter.consumer);
    if (filter.status !== undefined) q = q.andWhere("status", filter.status);
    if (filter.event_id !== undefined) q = q.andWhere("event_id", filter.event_id);
    if (filter.target_type !== undefined) q = q.andWhere("target_type", filter.target_type);
    if (filter.target_id !== undefined) q = q.andWhere("target_id", filter.target_id);
    if (filter.start !== undefined) q = q.andWhere("created_at", ">=", filter.start);
    if (filter.end !== undefined) q = q.andWhere("created_at", "<", filter.end);
    return q as unknown as T;
  }
}
