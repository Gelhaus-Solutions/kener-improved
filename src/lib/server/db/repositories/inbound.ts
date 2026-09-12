import { BaseRepository } from "./base.js";
import { runAcrossOrgs } from "../orgContext.js";

/**
 * H1. Inbound alert endpoints, and the alerts they have accepted.
 *
 * **One method here is cross-tenant, and it is the whole security story**, the
 * same shape as `findProbeAgentByTokenHash`. `findEndpointByTokenHash` is how
 * the org is *determined* for an arriving webhook: a stranger posts to a public
 * URL and there is no session, no host to trust and no context to scope by yet.
 * It is the only method that reads across orgs, it says so with `runAcrossOrgs`,
 * and it finds one row by an unguessable 256-bit token.
 *
 * Everything after that runs inside `runWithOrg(endpoint.org_id, ...)`, so the
 * alert rows, the monitor it maps to and the incident it opens are all scoped to
 * the tenant that owns the endpoint. An operator cannot aim another org's alerts
 * at their own page, or their own at somebody else's, because the token decides
 * the org before any of it happens.
 */

export interface InboundEndpointRecord {
  id: number;
  org_id: number;
  name: string;
  provider: string;
  token_hash: string;
  token_hint: string | null;
  signing_secret_encrypted: string | null;
  signing_secret_hint: string | null;
  status: string;
  default_monitor_tag: string | null;
  mapping_rules: string | null;
  default_impact: string | null;
  default_severity: string | null;
  auto_resolve: boolean | number;
  last_request_at: number | null;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface InboundAlertRecord {
  id: number;
  org_id: number;
  endpoint_id: number;
  fingerprint: string;
  status: string;
  monitor_tag: string | null;
  incident_id: number | null;
  severity: string | null;
  title: string | null;
  description: string | null;
  labels: string | null;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  notification_count: number;
  created_at: number;
  updated_at: number;
}

const ENDPOINTS = "inbound_endpoints";
const ALERTS = "inbound_alerts";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class InboundRepository extends BaseRepository {
  /**
   * The endpoint holding this token hash, across every org.
   *
   * Cross-tenant by declaration: this is the receive path and the token is the
   * only thing the caller has presented. `token_hash` is UNIQUE and indexed, so
   * this is one equality lookup rather than a scan.
   *
   * A disabled endpoint is returned rather than filtered out, so the caller can
   * tell "no such token" from "that receiver is switched off" and answer the
   * sender differently. Both still refuse the alert.
   */
  async findEndpointByTokenHash(tokenHash: string): Promise<InboundEndpointRecord | undefined> {
    return await runAcrossOrgs(() => this.knexUnscoped(ENDPOINTS).where({ token_hash: tokenHash }).first());
  }

  /**
   * Whether a token hash is already in use anywhere.
   *
   * Across orgs for the same reason `regionCodeExists` is: the unique index is
   * global, so a collision with another tenant's token would fail the insert
   * however well scoped the caller was. A collision is astronomically unlikely
   * with 256 bits of randomness; this exists so that if one ever happens it is a
   * sentence rather than a driver error.
   */
  async tokenHashExists(tokenHash: string): Promise<boolean> {
    const row = await runAcrossOrgs(() => this.knexUnscoped(ENDPOINTS).where({ token_hash: tokenHash }).first());
    return !!row;
  }

  async getInboundEndpoints(): Promise<InboundEndpointRecord[]> {
    return await this.table(ENDPOINTS).orderBy("id", "asc").select("*");
  }

  async getInboundEndpointById(id: number): Promise<InboundEndpointRecord | undefined> {
    return await this.table(ENDPOINTS).where({ id }).first();
  }

  async createInboundEndpoint(data: {
    name: string;
    provider: string;
    token_hash: string;
    token_hint: string | null;
    signing_secret_encrypted?: string | null;
    signing_secret_hint?: string | null;
    default_monitor_tag?: string | null;
    mapping_rules?: string | null;
    default_impact?: string | null;
    default_severity?: string | null;
    auto_resolve?: boolean;
  }): Promise<number> {
    const ts = nowSeconds();
    const inserted = await this.table(ENDPOINTS).insert(
      {
        ...data,
        auto_resolve: data.auto_resolve ?? true,
        status: "ACTIVE",
        created_at: ts,
        updated_at: ts,
      },
      ["id"],
    );
    const first = Array.isArray(inserted) ? inserted[0] : inserted;
    return typeof first === "object" ? Number((first as { id: number }).id) : Number(first);
  }

  async updateInboundEndpoint(
    id: number,
    patch: Partial<
      Pick<
        InboundEndpointRecord,
        | "name"
        | "status"
        | "default_monitor_tag"
        | "mapping_rules"
        | "default_impact"
        | "default_severity"
        | "signing_secret_encrypted"
        | "signing_secret_hint"
        | "token_hash"
        | "token_hint"
      >
    > & { auto_resolve?: boolean },
  ): Promise<number> {
    if (Object.keys(patch).length === 0) return 0;
    return await this.table(ENDPOINTS)
      .where({ id })
      .update({ ...patch, updated_at: nowSeconds() });
  }

  async deleteInboundEndpoint(id: number): Promise<number> {
    // The alerts go with it. They are only meaningful next to the endpoint that
    // received them, and leaving them orphaned would show a screen full of rows
    // whose origin no longer exists.
    await this.table(ALERTS).where({ endpoint_id: id }).del();
    return await this.table(ENDPOINTS).where({ id }).del();
  }

  /**
   * Records that a request arrived, and how it went.
   *
   * Written on every request including refused ones, because "nothing is
   * arriving" and "everything arriving is being rejected" are the two states an
   * operator confuses, and only these columns tell them apart.
   */
  async recordEndpointRequest(
    id: number,
    outcome: { ok: boolean; error?: string | null; at?: number },
  ): Promise<void> {
    const ts = outcome.at ?? nowSeconds();
    await this.table(ENDPOINTS)
      .where({ id })
      .update({
        last_request_at: ts,
        ...(outcome.ok
          ? { last_success_at: ts, last_error: null }
          : { last_failure_at: ts, last_error: outcome.error ?? null }),
        updated_at: ts,
      });
  }

  async getInboundAlert(endpointId: number, fingerprint: string): Promise<InboundAlertRecord | undefined> {
    return await this.table(ALERTS).where({ endpoint_id: endpointId, fingerprint }).first();
  }

  async insertInboundAlert(data: {
    endpoint_id: number;
    fingerprint: string;
    status: string;
    monitor_tag: string | null;
    incident_id: number | null;
    severity: string | null;
    title: string | null;
    description: string | null;
    labels: string | null;
    first_seen_at: number;
    last_seen_at: number;
    resolved_at?: number | null;
  }): Promise<number> {
    const ts = nowSeconds();
    const inserted = await this.table(ALERTS).insert(
      { ...data, notification_count: 1, created_at: ts, updated_at: ts },
      ["id"],
    );
    const first = Array.isArray(inserted) ? inserted[0] : inserted;
    return typeof first === "object" ? Number((first as { id: number }).id) : Number(first);
  }

  async updateInboundAlert(
    id: number,
    patch: Partial<
      Pick<
        InboundAlertRecord,
        | "status"
        | "monitor_tag"
        | "incident_id"
        | "severity"
        | "title"
        | "description"
        | "labels"
        | "last_seen_at"
        | "resolved_at"
        | "notification_count"
        | "first_seen_at"
      >
    >,
  ): Promise<number> {
    return await this.table(ALERTS)
      .where({ id })
      .update({ ...patch, updated_at: nowSeconds() });
  }

  /** The endpoint's recent traffic, newest first, for the screen. */
  async getRecentInboundAlerts(limit = 50, endpointId?: number): Promise<InboundAlertRecord[]> {
    const query = this.table(ALERTS).orderBy("last_seen_at", "desc").limit(limit);
    if (endpointId !== undefined) query.where({ endpoint_id: endpointId });
    return await query.select("*");
  }
}
