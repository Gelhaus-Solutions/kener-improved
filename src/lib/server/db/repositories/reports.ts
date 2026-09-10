import { BaseRepository } from "./base.js";
import { runAcrossOrgs } from "../orgContext.js";

/**
 * Report schedules and generated artifacts (F4).
 *
 * One method here is deliberately unscoped and it is called out where it is:
 * `getArtifactByToken`. Everything else goes through `table()` and is confined
 * to the caller's org.
 */

export interface ReportScheduleRow {
  id: number;
  org_id: number;
  name: string;
  scope_type: string;
  scope_ref: string;
  format: string;
  grain: string;
  range_kind: string;
  rrule: string;
  timezone: string;
  /** JSON array of literal addresses. */
  recipients: string;
  /** JSON array of page ids whose subscribers also receive it. */
  recipient_page_ids: string;
  exclude_maintenance: string;
  degraded_counts_as_bad: string;
  status: string;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type ReportScheduleInsert = Omit<ReportScheduleRow, "id" | "org_id">;

export interface ReportArtifactRow {
  id: number;
  org_id: number;
  report_schedule_id: number | null;
  filename: string;
  format: string;
  content_type: string;
  storage_key: string;
  size_bytes: number;
  range_from: number;
  range_to: number;
  download_token: string;
  expires_at: number;
  created_at: number;
}

export type ReportArtifactInsert = Omit<ReportArtifactRow, "id" | "org_id">;

const SCHEDULES = "report_schedules";
const ARTIFACTS = "report_artifacts";

export class ReportsRepository extends BaseRepository {
  async getReportSchedules(filter: { status?: string } = {}): Promise<ReportScheduleRow[]> {
    let query = this.table(SCHEDULES).select("*");
    if (filter.status) query = query.where("status", filter.status);
    return await query.orderBy("name", "asc");
  }

  async getReportScheduleById(id: number): Promise<ReportScheduleRow | undefined> {
    return await this.table(SCHEDULES).where("id", id).first();
  }

  async insertReportSchedule(row: ReportScheduleInsert): Promise<number> {
    // Every column named explicitly, and that is the point rather than a habit:
    // an explicit whitelist that silently drops a new column is the bug this
    // repository has now been bitten by twice (`insertMonitor`,
    // `insertMonitorAlertConfig`). Listing them here means adding a column to
    // the table without adding it here fails a driver assertion rather than
    // saving a row that quietly forgot half of what was typed.
    const returned = await this.table(SCHEDULES)
      .insert({
        name: row.name,
        scope_type: row.scope_type,
        scope_ref: row.scope_ref,
        format: row.format,
        grain: row.grain,
        range_kind: row.range_kind,
        rrule: row.rrule,
        timezone: row.timezone,
        recipients: row.recipients,
        recipient_page_ids: row.recipient_page_ids,
        exclude_maintenance: row.exclude_maintenance,
        degraded_counts_as_bad: row.degraded_counts_as_bad,
        status: row.status,
        next_run_at: row.next_run_at,
        last_run_at: row.last_run_at,
        last_error: row.last_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })
      .returning("id");
    return Number((returned[0] as { id: number })?.id ?? returned[0]);
  }

  async updateReportSchedule(id: number, row: Partial<ReportScheduleInsert>): Promise<number> {
    const patch: Record<string, unknown> = {};
    for (const key of [
      "name",
      "scope_type",
      "scope_ref",
      "format",
      "grain",
      "range_kind",
      "rrule",
      "timezone",
      "recipients",
      "recipient_page_ids",
      "exclude_maintenance",
      "degraded_counts_as_bad",
      "status",
      "next_run_at",
      "last_run_at",
      "last_error",
      "updated_at",
    ] as const) {
      if (row[key] !== undefined) patch[key] = row[key];
    }
    if (Object.keys(patch).length === 0) return 0;
    return await this.table(SCHEDULES).where("id", id).update(patch);
  }

  async deleteReportSchedule(id: number): Promise<number> {
    return await this.table(SCHEDULES).where("id", id).delete();
  }

  /**
   * Due schedules across every org.
   *
   * Unscoped on purpose, like the rollup scheduler's org sweep: the hourly tick
   * has no org context of its own and needs to find work in all of them. The
   * *rendering* then runs inside `runWithOrg` for the row's own org, so nothing
   * downstream reads across a tenant boundary.
   */
  async getDueReportSchedules(nowTs: number, limit = 100): Promise<ReportScheduleRow[]> {
    return await runAcrossOrgs(() =>
      this.knexUnscoped(SCHEDULES)
        .select("*")
        .where("status", "ACTIVE")
        .whereNotNull("next_run_at")
        .andWhere("next_run_at", "<=", nowTs)
        .orderBy("next_run_at", "asc")
        .limit(limit),
    );
  }

  async insertReportArtifact(row: ReportArtifactInsert): Promise<number> {
    const returned = await this.table(ARTIFACTS)
      .insert({
        report_schedule_id: row.report_schedule_id,
        filename: row.filename,
        format: row.format,
        content_type: row.content_type,
        storage_key: row.storage_key,
        size_bytes: row.size_bytes,
        range_from: row.range_from,
        range_to: row.range_to,
        download_token: row.download_token,
        expires_at: row.expires_at,
        created_at: row.created_at,
      })
      .returning("id");
    return Number((returned[0] as { id: number })?.id ?? returned[0]);
  }

  /**
   * Resolves a download token, **across every org**.
   *
   * This is the one unscoped read here and it has to be: the token is what
   * *determines* the org, exactly as an API key does in `AuthenticateAPIKey`, so
   * looking it up inside an org context would mean deciding the answer before
   * asking the question. The token is unique across the table, so this can
   * resolve at most one row, and the caller enters that row's org before doing
   * anything else with it.
   *
   * Expiry is **not** checked here. The caller checks it and returns a distinct
   * status, so an expired link says "this link has expired" rather than "no such
   * report", which is the difference between a user re-requesting and a user
   * filing a bug.
   */
  async getArtifactByToken(token: string): Promise<ReportArtifactRow | undefined> {
    return await runAcrossOrgs(() => this.knexUnscoped(ARTIFACTS).select("*").where("download_token", token).first());
  }

  async getReportArtifacts(scheduleId?: number, limit = 50): Promise<ReportArtifactRow[]> {
    let query = this.table(ARTIFACTS).select("*");
    if (scheduleId !== undefined) query = query.where("report_schedule_id", scheduleId);
    return await query.orderBy("created_at", "desc").limit(limit);
  }

  /** Expired artifacts across every org, for the daily sweep. */
  async getExpiredArtifacts(nowTs: number, limit = 500): Promise<ReportArtifactRow[]> {
    return await runAcrossOrgs(() =>
      this.knexUnscoped(ARTIFACTS)
        .select("*")
        .where("expires_at", "<=", nowTs)
        .orderBy("expires_at", "asc")
        .limit(limit),
    );
  }

  async deleteArtifactRows(ids: ReadonlyArray<number>): Promise<number> {
    if (ids.length === 0) return 0;
    return await runAcrossOrgs(() =>
      this.knexUnscoped(ARTIFACTS)
        .whereIn("id", ids as number[])
        .delete(),
    );
  }
}
