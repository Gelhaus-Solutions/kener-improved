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
    const inserted = (await this.table("webhook_endpoints").insert(row).returning("id")) as { id: number }[] | number[];
    const first = inserted[0];
    return typeof first === "number" ? first : Number(first?.id ?? 0);
  }

  async updateEndpoint(id: number, patch: Partial<WebhookEndpointRecord>): Promise<number> {
    return await this.table("webhook_endpoints").where("id", id).update(patch);
  }

  async deleteEndpoint(id: number): Promise<number> {
    // webhook_endpoint_events cascades; it is configuration, not evidence.
    return await this.table("webhook_endpoints").where("id", id).del();
  }

  async getEndpointById(id: number): Promise<WebhookEndpointRecord | undefined> {
    const row = await this.table("webhook_endpoints").select("*").where("id", id).first();
    return row ? this.mapEndpoint(row as Record<string, unknown>) : undefined;
  }

  async getEndpoints(orgId: number): Promise<WebhookEndpointRecord[]> {
    const rows = (await this.table("webhook_endpoints")
      .select("*")
      .where("org_id", orgId)
      .orderBy("id", "asc")) as Record<string, unknown>[];
    return rows.map((r) => this.mapEndpoint(r));
  }

  async getEndpointsCount(orgId: number): Promise<CountResult | undefined> {
    return await this.table("webhook_endpoints").where("org_id", orgId).count("* as count").first<CountResult>();
  }

  /** Replaces an endpoint's subscription list wholesale. */
  async setEndpointEvents(endpointId: number, eventTypes: string[]): Promise<void> {
    await this.table("webhook_endpoint_events").where("endpoint_id", endpointId).del();
    if (eventTypes.length === 0) return;
    const unique = [...new Set(eventTypes)];
    await this.table("webhook_endpoint_events").insert(
      unique.map((event_type) => ({ endpoint_id: endpointId, event_type })),
    );
  }

  async getEndpointEvents(endpointId: number): Promise<string[]> {
    const rows = (await this.table("webhook_endpoint_events")
      .select("event_type")
      .where("endpoint_id", endpointId)
      .orderBy("event_type", "asc")) as { event_type: string }[];
    return rows.map((r) => r.event_type);
  }

  /**
   * E11 part 3. Replaces an endpoint's scope wholesale.
   *
   * Same shape as `setEndpointEvents` and for the same reason: the screen sends
   * the whole set it wants, so a delete-then-insert cannot leave a row the
   * operator removed. Both kinds are replaced together, or clearing every
   * monitor while keeping a page would need two calls that must not interleave.
   */
  async setEndpointScopes(endpointId: number, monitorTags: string[], pageSlugs: string[]): Promise<void> {
    await this.table("webhook_endpoint_scopes").where("endpoint_id", endpointId).del();

    const rows = [
      ...new Set(monitorTags.filter(Boolean)),
    ].map((scope_value) => ({ endpoint_id: endpointId, scope_type: "MONITOR", scope_value }));

    for (const scope_value of new Set(pageSlugs.filter(Boolean))) {
      rows.push({ endpoint_id: endpointId, scope_type: "PAGE", scope_value });
    }

    if (rows.length === 0) return;
    await this.table("webhook_endpoint_scopes").insert(rows);
  }

  /**
   * An endpoint's scope, split by kind.
   *
   * Always returns both arrays, empty when unscoped, because the caller's rule
   * keys on "did the operator configure this kind at all" and a missing key and
   * an empty list would then have to mean the same thing at every call site.
   */
  async getEndpointScopes(endpointId: number): Promise<{ monitorTags: string[]; pageSlugs: string[] }> {
    const rows = (await this.table("webhook_endpoint_scopes")
      .select("scope_type", "scope_value")
      .where("endpoint_id", endpointId)
      .orderBy("scope_value", "asc")) as { scope_type: string; scope_value: string }[];

    return {
      monitorTags: rows.filter((r) => r.scope_type === "MONITOR").map((r) => r.scope_value),
      pageSlugs: rows.filter((r) => r.scope_type === "PAGE").map((r) => r.scope_value),
    };
  }

  /**
   * Every scope row for a set of endpoints, in one query.
   *
   * **The relay calls this once per event, so the N+1 is the thing to avoid.**
   * Fanning out to twenty endpoints must not become twenty scope reads on top of
   * the twenty the subscription match already cost.
   */
  async getScopesForEndpoints(endpointIds: number[]): Promise<Map<number, { monitorTags: string[]; pageSlugs: string[] }>> {
    const result = new Map<number, { monitorTags: string[]; pageSlugs: string[] }>();
    for (const id of endpointIds) result.set(id, { monitorTags: [], pageSlugs: [] });
    if (endpointIds.length === 0) return result;

    const rows = (await this.table("webhook_endpoint_scopes")
      .select("endpoint_id", "scope_type", "scope_value")
      .whereIn("endpoint_id", endpointIds)) as {
      endpoint_id: number;
      scope_type: string;
      scope_value: string;
    }[];

    for (const row of rows) {
      const entry = result.get(row.endpoint_id);
      if (!entry) continue;
      if (row.scope_type === "MONITOR") entry.monitorTags.push(row.scope_value);
      else if (row.scope_type === "PAGE") entry.pageSlugs.push(row.scope_value);
    }

    return result;
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

    const rows = (await this.table("webhook_endpoints as e")
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
      await this.table("webhook_endpoints")
        .where("id", id)
        .update({ consecutive_failures: 0, last_success_at: now, updated_at: now });
      return 0;
    }

    await this.table("webhook_endpoints")
      .where("id", id)
      .update({
        consecutive_failures: this.knexUnscoped.raw("consecutive_failures + 1"),
        last_failure_at: now,
        updated_at: now,
      });

    const row = (await this.table("webhook_endpoints").select("consecutive_failures").where("id", id).first()) as
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
    const updated = await this.table("webhook_endpoints")
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
      // E11 part 4. Null stays null - it means "no policy" - so these cannot go
      // through Number(), which would turn it into 0 and read as a window of
      // zero seconds rather than as no window at all.
      batch_window_seconds: row.batch_window_seconds === null || row.batch_window_seconds === undefined
        ? null
        : Number(row.batch_window_seconds),
      max_per_minute: row.max_per_minute === null || row.max_per_minute === undefined
        ? null
        : Number(row.max_per_minute),
    };
  }
}
