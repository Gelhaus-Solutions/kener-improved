import { BaseRepository } from "./base.js";
import { ROLLUP_TABLES, type RollupGrain } from "../../types/db.js";
import type { SloCounts } from "../../services/slo.js";

/** A whole `sla_targets` row. */
export interface SlaTargetRow {
  id: number;
  org_id: number;
  name: string;
  scope_type: string;
  scope_ref: string;
  combination: string;
  region_id: number;
  objective_percent: number;
  window_type: string;
  window_days: number | null;
  calendar_period: string | null;
  /** YES | NO. */
  exclude_maintenance: string;
  /** YES | NO. */
  degraded_counts_as_bad: string;
  /** YES | NO. */
  show_on_public: string;
  status: string;
}

export type SlaTargetInsert = Omit<SlaTargetRow, "id" | "org_id">;

/** A whole `sla_evaluations` row. */
export interface SlaEvaluationRow {
  sla_target_id: number;
  window_start: number;
  window_end: number;
  count_total: number;
  count_good: number;
  count_bad: number;
  count_excluded: number;
  uptime_percent: number | null;
  objective_percent: number;
  budget_total: number | null;
  budget_consumed: number | null;
  budget_remaining_percent: number | null;
  burn_1h: number | null;
  burn_6h: number | null;
  burn_24h: number | null;
  burn_3d: number | null;
  monitor_count: number;
  computed_at: number;
}

const TARGETS = "sla_targets";
const EVALUATIONS = "sla_evaluations";

/**
 * SLO targets and their precomputed evaluations (F1a).
 *
 * Its own repository rather than a corner of `rollups.ts`: these are contract
 * definitions and a cache of arithmetic over them, while `rollups` owns the
 * sample aggregates. The one place they meet is `getSloCounts`, which lives here
 * because the columns it selects are chosen by what an SLO needs rather than by
 * what a rollup holds.
 */
export class SlaRepository extends BaseRepository {
  // ---- targets -----------------------------------------------------------

  async getSlaTargets(filter: { status?: string } = {}): Promise<SlaTargetRow[]> {
    const query = this.table(TARGETS).select("*").orderBy("id", "asc");
    if (filter.status) query.where("status", filter.status);
    return (await query).map(normalizeTarget);
  }

  async getSlaTargetById(id: number): Promise<SlaTargetRow | undefined> {
    const row = await this.table(TARGETS).where("id", id).first();
    return row ? normalizeTarget(row) : undefined;
  }

  /**
   * Every target whose scope names this monitor tag directly.
   *
   * Only `scope_type = 'MONITOR'`. Page and category scopes are resolved through
   * their membership tables, which this cannot see, so the public panel asks for
   * those separately rather than this quietly returning a partial answer.
   */
  async getSlaTargetsForMonitor(monitorTag: string): Promise<SlaTargetRow[]> {
    const rows = await this.table(TARGETS)
      .where("scope_type", "MONITOR")
      .where("scope_ref", monitorTag)
      .where("status", "ACTIVE")
      .orderBy("id", "asc");
    return rows.map(normalizeTarget);
  }

  async createSlaTarget(data: SlaTargetInsert): Promise<number> {
    // `org_id` is stamped by `table()` on the way in, so it is deliberately not
    // passed here: naming it would override the scoped value rather than confirm it.
    const [row] = await this.table(TARGETS).insert(data, ["id"]);
    // SQLite returns the id itself, Postgres returns a row object.
    return typeof row === "object" && row !== null ? Number((row as { id: number }).id) : Number(row);
  }

  async updateSlaTarget(id: number, data: Partial<SlaTargetInsert>): Promise<number> {
    return await this.table(TARGETS).where("id", id).update(data);
  }

  async deleteSlaTarget(id: number): Promise<number> {
    // The evaluation goes with it. There is no foreign key here on purpose:
    // `sla_evaluations` is a cache, and a cascade would be the only thing in the
    // schema pretending it is not disposable.
    await this.table(EVALUATIONS).where("sla_target_id", id).delete();
    return await this.table(TARGETS).where("id", id).delete();
  }

  // ---- evaluations -------------------------------------------------------

  async getSlaEvaluations(targetIds?: ReadonlyArray<number>): Promise<SlaEvaluationRow[]> {
    const query = this.table(EVALUATIONS).select("*");
    if (targetIds) {
      if (targetIds.length === 0) return [];
      query.whereIn("sla_target_id", targetIds as number[]);
    }
    return (await query).map(normalizeEvaluation);
  }

  /**
   * Writes the current evaluation for a target, replacing whatever was there.
   *
   * `merge()` naming every column deliberately: this row is the whole current
   * answer, so a partial merge that left a stale `burn_1h` next to a fresh
   * `uptime_percent` would be a row that never existed as a measurement.
   */
  async upsertSlaEvaluation(row: SlaEvaluationRow): Promise<void> {
    await this.table(EVALUATIONS)
      .insert(row)
      .onConflict("sla_target_id")
      .merge([
        "window_start",
        "window_end",
        "count_total",
        "count_good",
        "count_bad",
        "count_excluded",
        "uptime_percent",
        "objective_percent",
        "budget_total",
        "budget_consumed",
        "budget_remaining_percent",
        "burn_1h",
        "burn_6h",
        "burn_24h",
        "burn_3d",
        "monitor_count",
        "computed_at",
      ]);
  }

  // ---- the rollup read ---------------------------------------------------

  /**
   * The counts an SLO needs, summed per monitor over one window.
   *
   * **Not `getRollupBucketsAggregated`.** That one buckets by index for a chart
   * and does not select the `*_excl_maint` columns at all, which are exactly the
   * ones an SLA is written about. This is one row per tag over the whole window,
   * because an SLO wants a single total and bucketing it would be work thrown
   * away.
   */
  async getSloCounts(
    grain: RollupGrain,
    monitorTags: ReadonlyArray<string>,
    regionId: number,
    startTimestamp: number,
    endTimestamp: number,
  ): Promise<Map<string, SloCounts>> {
    const out = new Map<string, SloCounts>();
    if (monitorTags.length === 0) return out;

    const rows = await this.table(ROLLUP_TABLES[grain])
      .select("monitor_tag")
      .sum({ count_up: "count_up" })
      .sum({ count_down: "count_down" })
      .sum({ count_degraded: "count_degraded" })
      .sum({ count_maintenance: "count_maintenance" })
      .sum({ count_in_maint_window: "count_in_maint_window" })
      .sum({ count_up_excl_maint: "count_up_excl_maint" })
      .sum({ count_down_excl_maint: "count_down_excl_maint" })
      .sum({ count_degraded_excl_maint: "count_degraded_excl_maint" })
      .whereIn("monitor_tag", monitorTags as string[])
      .where("region_id", regionId)
      .where("bucket_start", ">=", startTimestamp)
      .where("bucket_start", "<", endTimestamp)
      .groupBy("monitor_tag");

    for (const row of rows as Array<Record<string, unknown>>) {
      out.set(String(row.monitor_tag), {
        count_up: Number(row.count_up ?? 0),
        count_down: Number(row.count_down ?? 0),
        count_degraded: Number(row.count_degraded ?? 0),
        count_maintenance: Number(row.count_maintenance ?? 0),
        count_in_maint_window: Number(row.count_in_maint_window ?? 0),
        count_up_excl_maint: Number(row.count_up_excl_maint ?? 0),
        count_down_excl_maint: Number(row.count_down_excl_maint ?? 0),
        count_degraded_excl_maint: Number(row.count_degraded_excl_maint ?? 0),
      });
    }
    return out;
  }
}

function normalizeTarget(row: Record<string, unknown>): SlaTargetRow {
  return {
    id: Number(row.id),
    org_id: Number(row.org_id),
    name: String(row.name ?? ""),
    scope_type: String(row.scope_type ?? "MONITOR"),
    scope_ref: String(row.scope_ref ?? ""),
    combination: String(row.combination ?? "WORST"),
    region_id: Number(row.region_id ?? 0),
    objective_percent: Number(row.objective_percent ?? 0),
    window_type: String(row.window_type ?? "ROLLING"),
    window_days: row.window_days === null || row.window_days === undefined ? null : Number(row.window_days),
    calendar_period:
      row.calendar_period === null || row.calendar_period === undefined ? null : String(row.calendar_period),
    exclude_maintenance: String(row.exclude_maintenance ?? "YES"),
    degraded_counts_as_bad: String(row.degraded_counts_as_bad ?? "NO"),
    show_on_public: String(row.show_on_public ?? "NO"),
    status: String(row.status ?? "ACTIVE"),
  };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function normalizeEvaluation(row: Record<string, unknown>): SlaEvaluationRow {
  return {
    sla_target_id: Number(row.sla_target_id),
    window_start: Number(row.window_start ?? 0),
    window_end: Number(row.window_end ?? 0),
    count_total: Number(row.count_total ?? 0),
    count_good: Number(row.count_good ?? 0),
    count_bad: Number(row.count_bad ?? 0),
    count_excluded: Number(row.count_excluded ?? 0),
    uptime_percent: num(row.uptime_percent),
    objective_percent: Number(row.objective_percent ?? 0),
    budget_total: num(row.budget_total),
    budget_consumed: num(row.budget_consumed),
    budget_remaining_percent: num(row.budget_remaining_percent),
    burn_1h: num(row.burn_1h),
    burn_6h: num(row.burn_6h),
    burn_24h: num(row.burn_24h),
    burn_3d: num(row.burn_3d),
    monitor_count: Number(row.monitor_count ?? 0),
    computed_at: Number(row.computed_at ?? 0),
  };
}
