import { BaseRepository, type CountResult } from "./base.js";
import { hasDeclarativePartitioning } from "../capabilities.js";
import type { AuditLogRecord, AuditLogInsert, AuditLogFilter } from "../../types/db.js";

/**
 * The audit log.
 *
 * **This class deliberately has no update and no delete.** That is the
 * application half of the append-only guarantee: the method you would need in
 * order to rewrite history does not exist to be called, so no amount of "just
 * this once" reaches it. On Postgres the privilege is revoked as well; see
 * migrations/20260908150000_audit_log_append_only_pg.ts.
 *
 * The single exception is `prune`, which enforces retention. It takes a cutoff
 * and nothing else, so the only expressible deletion is "older than a date".
 */
export class AuditRepository extends BaseRepository {
  /** Appends rows. Batched by the writer; never call this per request. */
  async insertMany(rows: AuditLogInsert[]): Promise<void> {
    if (rows.length === 0) return;
    // Chunked because SQLite caps bound variables per statement and a burst of
    // admin activity can flush a large batch.
    await this.knex.batchInsert("audit_log", rows, 100);
  }

  async getAuditLogPaginated(filter: AuditLogFilter, page: number, limit: number): Promise<AuditLogRecord[]> {
    return await this.applyFilter(this.knex("audit_log").select("*"), filter)
      .orderBy("ts", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .offset((page - 1) * limit);
  }

  async getAuditLogCount(filter: AuditLogFilter): Promise<CountResult | undefined> {
    return await this.applyFilter(this.knex("audit_log").count("* as count"), filter).first<CountResult>();
  }

  /** Every row written by one request, for tracing a single admin operation. */
  async getAuditLogByRequestId(requestId: string): Promise<AuditLogRecord[]> {
    return await this.knex("audit_log").select("*").where("request_id", requestId).orderBy("id", "asc");
  }

  /**
   * Deletes rows older than `cutoffTs`. The only deletion this repository can
   * express, and the only one retention needs.
   *
   * On Postgres the app role has no DELETE privilege, so this goes through the
   * SECURITY DEFINER function the append-only migration created. Elsewhere it is
   * a plain delete, because there is no privilege to route around.
   */
  async prune(cutoffTs: number): Promise<number> {
    if (hasDeclarativePartitioning(this.knex)) {
      // Same capability, same dialect: Postgres. Others delete directly below.
      const result = await this.knex.raw("SELECT audit_log_prune(?) AS removed", [cutoffTs]);
      return Number(result?.rows?.[0]?.removed ?? 0);
    }
    return await this.knex("audit_log").where("ts", "<", cutoffTs).del();
  }

  private applyFilter<T extends { where: (...args: never[]) => T }>(query: T, filter: AuditLogFilter): T {
    let q = query as unknown as {
      andWhere: (...args: unknown[]) => typeof q;
      whereRaw: (...args: unknown[]) => typeof q;
    };
    if (filter.org_id !== undefined) q = q.andWhere("org_id", filter.org_id);
    if (filter.action !== undefined) q = q.andWhere("action", filter.action);
    if (filter.actor_type !== undefined) q = q.andWhere("actor_type", filter.actor_type);
    if (filter.actor_id !== undefined) q = q.andWhere("actor_id", filter.actor_id);
    if (filter.outcome !== undefined) q = q.andWhere("outcome", filter.outcome);
    if (filter.start !== undefined) q = q.andWhere("ts", ">=", filter.start);
    if (filter.end !== undefined) q = q.andWhere("ts", "<", filter.end);
    return q as unknown as T;
  }
}
