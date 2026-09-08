import { BaseRepository, type CountResult } from "./base.js";
import type {
  WebhookEndpointRecord,
  WebhookEndpointInsert,
  WebhookEndpointWithEvents,
  WebhookEndpointStatus,
} from "../../types/db.js";

/**
 * Outbound webhook endpoints and their subscriptions.
 *
 * Delivery attempts are not here. They live in `event_deliveries` with every
 * other outbound channel, which is what makes one screen able to show them all.
 */
export class WebhooksRepository extends BaseRepository {
  async createEndpoint(row: WebhookEndpointInsert): Promise<number> {
    const inserted = (await this.knex("webhook_endpoints").insert(row).returning("id")) as { id: number }[] | number[];
    const first = inserted[0];
    return typeof first === "number" ? first : Number(first?.id ?? 0);
  }

  async updateEndpoint(id: number, patch: Partial<WebhookEndpointRecord>): Promise<number> {
    return await this.knex("webhook_endpoints").where("id", id).update(patch);
  }

  async deleteEndpoint(id: number): Promise<number> {
    // webhook_endpoint_events cascades; it is configuration, not evidence.
    return await this.knex("webhook_endpoints").where("id", id).del();
  }

  async getEndpointById(id: number): Promise<WebhookEndpointRecord | undefined> {
    const row = await this.knex("webhook_endpoints").select("*").where("id", id).first();
    return row ? this.mapEndpoint(row as Record<string, unknown>) : undefined;
  }

  async getEndpoints(orgId: number): Promise<WebhookEndpointRecord[]> {
    const rows = (await this.knex("webhook_endpoints")
      .select("*")
      .where("org_id", orgId)
      .orderBy("id", "asc")) as Record<string, unknown>[];
    return rows.map((r) => this.mapEndpoint(r));
  }

  async getEndpointsCount(orgId: number): Promise<CountResult | undefined> {
    return await this.knex("webhook_endpoints").where("org_id", orgId).count("* as count").first<CountResult>();
  }

  /** Replaces an endpoint's subscription list wholesale. */
  async setEndpointEvents(endpointId: number, eventTypes: string[]): Promise<void> {
    await this.knex("webhook_endpoint_events").where("endpoint_id", endpointId).del();
    if (eventTypes.length === 0) return;
    const unique = [...new Set(eventTypes)];
    await this.knex("webhook_endpoint_events").insert(
      unique.map((event_type) => ({ endpoint_id: endpointId, event_type })),
    );
  }

  async getEndpointEvents(endpointId: number): Promise<string[]> {
    const rows = (await this.knex("webhook_endpoint_events")
      .select("event_type")
      .where("endpoint_id", endpointId)
      .orderBy("event_type", "asc")) as { event_type: string }[];
    return rows.map((r) => r.event_type);
  }

  /**
   * Every ACTIVE endpoint in an org that subscribes to `eventType`, either
   * exactly or through its domain wildcard.
   *
   * One query with both forms rather than a fetch-then-filter, because the relay
   * calls this once per event and an instance can hold a lot of endpoints. The
   * wildcard is computed here rather than stored expanded, so an endpoint
   * subscribed to `incident.*` picks up a new incident type the day it is added
   * instead of the day someone remembers to re-save the endpoint.
   */
  async getActiveEndpointsForEvent(orgId: number, eventType: string): Promise<WebhookEndpointWithEvents[]> {
    const wildcard = `${eventType.slice(0, eventType.indexOf("."))}.*`;

    const rows = (await this.knex("webhook_endpoints as e")
      .join("webhook_endpoint_events as s", "s.endpoint_id", "e.id")
      .select("e.*")
      .where("e.org_id", orgId)
      .andWhere("e.status", "ACTIVE")
      .whereIn("s.event_type", [eventType, wildcard])
      .groupBy("e.id")
      .orderBy("e.id", "asc")) as Record<string, unknown>[];

    return rows.map((r) => ({ ...this.mapEndpoint(r), event_types: [] }));
  }

  /**
   * Records a delivery outcome against the endpoint.
   *
   * A success resets the failure run to zero, so the counter measures a
   * *current* outage rather than a lifetime total; an endpoint that fails once a
   * week forever should never be auto-disabled.
   *
   * Returns the new consecutive-failure count so the caller can decide whether
   * the endpoint has earned an auto-disable, without a second read.
   */
  async recordEndpointOutcome(id: number, ok: boolean, now: number): Promise<number> {
    if (ok) {
      await this.knex("webhook_endpoints")
        .where("id", id)
        .update({ consecutive_failures: 0, last_success_at: now, updated_at: now });
      return 0;
    }

    await this.knex("webhook_endpoints")
      .where("id", id)
      .update({
        consecutive_failures: this.knex.raw("consecutive_failures + 1"),
        last_failure_at: now,
        updated_at: now,
      });

    const row = (await this.knex("webhook_endpoints").select("consecutive_failures").where("id", id).first()) as
      | { consecutive_failures: number }
      | undefined;
    return Number(row?.consecutive_failures ?? 0);
  }

  /**
   * Stops an endpoint that has failed too many times running.
   *
   * Conditional on it still being ACTIVE, so two workers noticing the same
   * threshold at once disable it once and only one of them announces it.
   */
  async autoDisableEndpoint(id: number, now: number): Promise<boolean> {
    const updated = await this.knex("webhook_endpoints")
      .where("id", id)
      .where("status", "ACTIVE")
      .update({ status: "DISABLED_AUTO" as WebhookEndpointStatus, updated_at: now })
      .then((n) => Number(n));
    return updated > 0;
  }

  private mapEndpoint(row: Record<string, unknown>): WebhookEndpointRecord {
    return {
      ...(row as unknown as WebhookEndpointRecord),
      id: Number(row.id),
      org_id: Number(row.org_id),
      timeout_ms: Number(row.timeout_ms),
      consecutive_failures: Number(row.consecutive_failures),
    };
  }
}
