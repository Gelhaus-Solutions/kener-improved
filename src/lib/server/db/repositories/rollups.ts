import { BaseRepository } from "./base.js";
import { hasFloorFunction } from "../capabilities.js";
import { markRollupDirty, type DirtyRange } from "../rollupDirty.js";
import { MERGED_REGION_ID } from "../regions.js";
import { ROLLUP_TABLES, type MonitorRollup, type MonitorRollupInput, type RollupGrain } from "../../types/db.js";
import type { MaintenanceWindow, RollupSample } from "../../services/rollupCompute.js";

/**
 * Reading and writing the rollup tables, the watermarks and the dirty set (F6b).
 *
 * The arithmetic lives in `services/rollupCompute.ts` and the orchestration in
 * `services/rollupEngine.ts`; this file is only the queries.
 */

export interface RollupState {
  org_id: number;
  grain: RollupGrain;
  region_id: number;
  watermark_ts: number | null;
  backfill_complete: boolean;
  backfill_cursor_ts: number | null;
  backfill_started_at: number | null;
  backfill_completed_at: number | null;
  updated_at: number;
}

export interface DirtyHour {
  monitor_tag: string;
  region_id: number;
  hour_start: number;
}

/** Refuses anything that has no business being interpolated into SQL. */
function safeInt(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Refusing to build a rollup bucket expression from ${value}`);
  return value;
}

export class RollupsRepository extends BaseRepository {
  // ---- state ------------------------------------------------------------

  async getRollupState(grain: RollupGrain, regionId: number = MERGED_REGION_ID): Promise<RollupState | undefined> {
    const row = await this.table("rollup_state").where({ grain, region_id: regionId }).first();
    if (!row) return undefined;
    return {
      ...row,
      // SQLite has no boolean type and hands back 0 or 1. Normalising here means
      // the kill switch cannot be accidentally truthy on one dialect and not the
      // other, which is exactly the kind of difference that would only show up
      // in production.
      backfill_complete: !!row.backfill_complete,
    } as RollupState;
  }

  async getAllRollupStates(): Promise<RollupState[]> {
    const rows = await this.table("rollup_state").select("*");
    return rows.map((row: RollupState) => ({ ...row, backfill_complete: !!row.backfill_complete }));
  }

  async upsertRollupState(
    grain: RollupGrain,
    regionId: number,
    patch: Partial<Omit<RollupState, "org_id" | "grain" | "region_id">>,
    nowTs: number,
  ): Promise<void> {
    const existing = await this.table("rollup_state").where({ grain, region_id: regionId }).first();
    if (existing) {
      await this.table("rollup_state")
        .where({ grain, region_id: regionId })
        .update({ ...patch, updated_at: nowTs });
      return;
    }
    await this.table("rollup_state").insert({
      grain,
      region_id: regionId,
      watermark_ts: null,
      backfill_complete: false,
      backfill_cursor_ts: null,
      backfill_started_at: null,
      backfill_completed_at: null,
      ...patch,
      updated_at: nowTs,
    });
  }

  // ---- the dirty set ----------------------------------------------------

  /**
   * Marks every hour touched by each range.
   *
   * Delegates to the free function so that this and `MonitoringRepository`'s
   * three history-rewriting methods mark identically - the marking happens
   * inside those methods' own transactions, which is why the logic cannot live
   * on a repository at all.
   */
  async markDirty(ranges: ReadonlyArray<DirtyRange>, nowTs: number): Promise<number> {
    return await markRollupDirty(this.knexUnscoped, ranges, nowTs);
  }

  /**
   * The next batch of hours to recompute, oldest mark first.
   *
   * Oldest first so a steady trickle of invalidations cannot starve one that
   * arrived during a backlog, and so the drain is fair across monitors rather
   * than following whatever order the index happens to produce.
   */
  async takeDirtyHours(limit: number): Promise<DirtyHour[]> {
    return await this.table("rollup_dirty")
      .select("monitor_tag", "region_id", "hour_start")
      .orderBy("marked_at", "asc")
      .orderBy("hour_start", "asc")
      .limit(limit);
  }

  async countDirtyHours(): Promise<number> {
    const row = await this.table("rollup_dirty").count("* as c").first();
    return Number(row?.c ?? 0);
  }

  /**
   * Removes hours that have been recomputed.
   *
   * **Called after the recompute, never before.** A crash between the two leaves
   * the hour marked and it is simply recomputed again, which costs one repeated
   * aggregate. Clearing first would lose the invalidation entirely and leave a
   * bucket permanently disagreeing with its samples.
   */
  async clearDirtyHours(hours: ReadonlyArray<DirtyHour>): Promise<number> {
    if (hours.length === 0) return 0;
    let removed = 0;
    const batchSize = 200;
    for (let i = 0; i < hours.length; i += batchSize) {
      const batch = hours.slice(i, i + batchSize);
      removed += await this.table("rollup_dirty")
        .where((builder) => {
          for (const hour of batch) {
            builder.orWhere({
              monitor_tag: hour.monitor_tag,
              region_id: hour.region_id,
              hour_start: hour.hour_start,
            });
          }
        })
        .del();
    }
    return removed;
  }

  // ---- the rollup tables ------------------------------------------------

  /**
   * Writes buckets, replacing whatever was there.
   *
   * A full replace rather than a merge of changed columns: a bucket is always
   * computed from all of its source rows, so a partial update could only ever
   * produce a row that is half one computation and half another.
   */
  async upsertRollups(grain: RollupGrain, rows: ReadonlyArray<MonitorRollupInput>): Promise<number> {
    if (rows.length === 0) return 0;
    const table = ROLLUP_TABLES[grain];
    const columns = Object.keys(rows[0]).filter(
      (column) => !["org_id", "monitor_tag", "region_id", "bucket_start"].includes(column),
    );
    const batchSize = 200;
    for (let i = 0; i < rows.length; i += batchSize) {
      await this.table(table)
        .insert(rows.slice(i, i + batchSize) as unknown as Record<string, unknown>[])
        .onConflict(["org_id", "monitor_tag", "region_id", "bucket_start"])
        .merge(columns);
    }
    return rows.length;
  }

  async getRollups(
    grain: RollupGrain,
    monitorTags: ReadonlyArray<string>,
    regionId: number,
    from: number,
    to: number,
  ): Promise<MonitorRollup[]> {
    if (monitorTags.length === 0) return [];
    return await this.table(ROLLUP_TABLES[grain])
      .whereIn("monitor_tag", monitorTags as string[])
      .where("region_id", regionId)
      .where("bucket_start", ">=", from)
      .where("bucket_start", "<", to)
      .orderBy("monitor_tag", "asc")
      .orderBy("bucket_start", "asc");
  }

  /**
   * Sums rollup buckets into the caller's own buckets, **in SQL**.
   *
   * The obvious implementation of the read path fetches rollup rows and folds
   * them in JavaScript, and for the daily grain that is fine: ninety rows per
   * monitor. For the five-minute grain it is not. A Kolkata viewer needs 5m
   * buckets (see `uptimeAggregator`), which is 25,920 rows per monitor for a
   * 90-day bar, and each one is a 28-column row shipped over the wire only to be
   * added up and thrown away. Measured against the raw SQL it replaces, that was
   * **slower** - 179ms against 12ms on the fixture - because the query being
   * replaced aggregates server-side and returns ninety rows.
   *
   * So the grouping happens in the database, exactly as it did before, and only
   * the finished buckets travel. The percentile histogram is deliberately not
   * selected here: it cannot be merged in SQL, and the bar does not need it.
   * A percentile read (B4, F3) is a different query that fetches histograms for
   * the far smaller number of buckets it actually spans.
   *
   * `start` and `interval` are interpolated rather than bound because they sit
   * in the GROUP BY as well as the SELECT, and knex orders bindings by position
   * in the compiled statement - so the same value has to be bound twice in the
   * right order or the query silently groups by something else. They are
   * integers from this process, and `safeInt` refuses anything that is not.
   */
  async getRollupBucketsAggregated(
    grain: RollupGrain,
    monitorTags: ReadonlyArray<string>,
    regionId: number,
    startTimestamp: number,
    intervalSeconds: number,
    endTimestamp: number,
  ): Promise<
    Array<{
      monitor_tag: string;
      bucket_index: number;
      count_total: number;
      count_up: number;
      count_down: number;
      count_degraded: number;
      count_maintenance: number;
      latency_count: number;
      latency_sum: number;
      latency_min: number | null;
      latency_max: number | null;
    }>
  > {
    if (monitorTags.length === 0) return [];
    const start = safeInt(startTimestamp);
    const interval = safeInt(intervalSeconds);

    // SQLite has no FLOOR(); CAST(x AS INT) truncates the same way, and the
    // operand is non-negative because the range is clamped to `>= start`.
    const bucketExpr = hasFloorFunction(this.knexUnscoped)
      ? `FLOOR((bucket_start - ${start}) / ${interval})`
      : `CAST((bucket_start - ${start}) / ${interval} AS INT)`;

    const rows = await this.table(ROLLUP_TABLES[grain])
      .select(
        "monitor_tag",
        this.knexUnscoped.raw(`${bucketExpr} as bucket_index`),
        this.knexUnscoped.raw("SUM(count_total) as count_total"),
        this.knexUnscoped.raw("SUM(count_up) as count_up"),
        this.knexUnscoped.raw("SUM(count_down) as count_down"),
        this.knexUnscoped.raw("SUM(count_degraded) as count_degraded"),
        this.knexUnscoped.raw("SUM(count_maintenance) as count_maintenance"),
        this.knexUnscoped.raw("SUM(latency_count) as latency_count"),
        this.knexUnscoped.raw("SUM(latency_sum) as latency_sum"),
        this.knexUnscoped.raw("MIN(latency_min) as latency_min"),
        this.knexUnscoped.raw("MAX(latency_max) as latency_max"),
      )
      .whereIn("monitor_tag", monitorTags as string[])
      .where("region_id", regionId)
      .where("bucket_start", ">=", start)
      .where("bucket_start", "<", endTimestamp)
      .groupBy("monitor_tag")
      .groupByRaw(bucketExpr);

    return rows.map((row: Record<string, unknown>) => ({
      monitor_tag: String(row.monitor_tag),
      bucket_index: Number(row.bucket_index),
      count_total: Number(row.count_total ?? 0),
      count_up: Number(row.count_up ?? 0),
      count_down: Number(row.count_down ?? 0),
      count_degraded: Number(row.count_degraded ?? 0),
      count_maintenance: Number(row.count_maintenance ?? 0),
      latency_count: Number(row.latency_count ?? 0),
      latency_sum: Number(row.latency_sum ?? 0),
      latency_min: row.latency_min === null || row.latency_min === undefined ? null : Number(row.latency_min),
      latency_max: row.latency_max === null || row.latency_max === undefined ? null : Number(row.latency_max),
    }));
  }

  /** Removes buckets in a window. Used when the samples behind them are deleted. */
  async deleteRollups(
    grain: RollupGrain,
    monitorTag: string,
    regionId: number | null,
    from: number | null,
    to: number | null,
  ): Promise<number> {
    const query = this.table(ROLLUP_TABLES[grain]).where("monitor_tag", monitorTag);
    if (regionId !== null) query.where("region_id", regionId);
    if (from !== null) query.where("bucket_start", ">=", from);
    if (to !== null) query.where("bucket_start", "<", to);
    return await query.del();
  }

  // ---- the sources ------------------------------------------------------

  /**
   * The raw samples behind a window, for one monitor and one region.
   *
   * Only the five columns the aggregation reads. `monitoring_data` is the
   * largest table and this runs once per hour per monitor during a backfill, so
   * the row width is not a detail.
   *
   * `region_id` is a parameter rather than fixed at 0, because a rollup is
   * computed *per region*: the day probes exist, each one's samples roll up into
   * its own buckets and the merged verdict keeps rolling up into region 0.
   */
  async getRawSamples(monitorTag: string, regionId: number, from: number, to: number): Promise<RollupSample[]> {
    return await this.table("monitoring_data")
      .select("monitor_tag", "timestamp", "status", "type", "latency")
      .where("monitor_tag", monitorTag)
      .where("region_id", regionId)
      .where("timestamp", ">=", from)
      .where("timestamp", "<", to)
      .orderBy("timestamp", "asc");
  }

  /** The oldest and newest sample in a region, for sizing the backfill. */
  async getRawSampleBounds(regionId: number): Promise<{ lo: number; hi: number } | null> {
    const row = (await this.table("monitoring_data")
      .where("region_id", regionId)
      .min({ lo: "timestamp" })
      .max({ hi: "timestamp" })
      .first()) as { lo?: number | string | null; hi?: number | string | null } | undefined;
    if (!row || row.lo === null || row.lo === undefined) return null;
    return { lo: Number(row.lo), hi: Number(row.hi) };
  }

  /** Every monitor tag that has samples in a region. Drives the backfill's fan-out. */
  async getTagsWithSamples(regionId: number, from: number, to: number): Promise<string[]> {
    const rows = await this.table("monitoring_data")
      .distinct("monitor_tag")
      .where("region_id", regionId)
      .where("timestamp", ">=", from)
      .where("timestamp", "<", to);
    return rows.map((row: { monitor_tag: string }) => row.monitor_tag);
  }

  /**
   * Maintenance windows overlapping a range, per monitor.
   *
   * From `maintenances_events` joined through `maintenance_monitors`, which is
   * the *communication* record of a planned window - deliberately not the
   * sample's own `MAINTENANCE` type. A sample can carry that type with no window
   * on the books, and a window can cover samples nothing ever retyped; an SLA is
   * written about the window.
   *
   * CANCELLED events are excluded: a window that was called off did not happen,
   * and excluding its minutes from an availability figure would be a way of
   * hiding an outage behind maintenance that never took place.
   */
  async getMaintenanceWindows(
    monitorTags: ReadonlyArray<string>,
    from: number,
    to: number,
  ): Promise<Map<string, MaintenanceWindow[]>> {
    const byTag = new Map<string, MaintenanceWindow[]>();
    if (monitorTags.length === 0) return byTag;

    const rows = await this.table("maintenances_events as me")
      .select(
        "mm.monitor_tag as monitor_tag",
        "me.start_date_time as start_date_time",
        "me.end_date_time as end_date_time",
      )
      .innerJoin("maintenance_monitors as mm", "me.maintenance_id", "mm.maintenance_id")
      .whereIn("mm.monitor_tag", monitorTags as string[])
      .whereNot("me.status", "CANCELLED")
      .andWhere("me.start_date_time", "<", to)
      .andWhere("me.end_date_time", ">", from);

    for (const row of rows) {
      const list = byTag.get(row.monitor_tag) ?? [];
      list.push({ start: Number(row.start_date_time), end: Number(row.end_date_time) });
      byTag.set(row.monitor_tag, list);
    }
    return byTag;
  }
}
