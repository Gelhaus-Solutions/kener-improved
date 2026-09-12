import type { Knex as KnexType } from "knex";
import { BaseRepository } from "./base.js";
import { requireOrgId } from "../orgContext.js";
import { MERGED_REGION_ID } from "../regions.js";
import { markRollupDirty } from "../rollupDirty.js";
import { hasFloorFunction, supportsInsertReturning } from "../capabilities.js";
import GC from "../../../global-constants.js";
import type { MonitoringStatus } from "../../../types/status.js";
import { GetMinuteStartNowTimestampUTC, GetNowTimestampUTC } from "../../tool.js";
import { ROLLUP_TABLES } from "../../types/db.js";
import type {
  MonitoringData,
  MonitoringDataInsert,
  AggregatedMonitoringData,
  TimestampStatusCount,
  TimestampStatusCountByMonitor,
} from "../../types/db.js";

/**
 * Sample types alert evaluation can see (see docs/adr/0005-alerts-evaluate-alert-visible-samples.md).
 * Exactly the types written by flows that enqueue alert evaluation: scheduler checks
 * (REALTIME/ERROR/TIMEOUT), default-status fill (DEFAULT_STATUS), and data-API pushes (MANUAL).
 * SIGNAL rows (raw heartbeat receipts) and INCIDENT/MAINTENANCE overlays stay invisible, so the
 * alert window freezes during manual overlays instead of triggering or resolving on them.
 */
const ALERT_VISIBLE_TYPES = [GC.REALTIME, GC.ERROR, GC.TIMEOUT, GC.MANUAL, GC.DEFAULT_STATUS, GC.OPERATOR];

/**
 * Scheduled-check sample types that count toward a monitor's Confirmation Threshold
 * (issue #712). Intentionally narrower than ALERT_VISIBLE_TYPES: MANUAL pushes
 * and DEFAULT_STATUS fill stay transparent to threshold counting.
 */
const OBSERVED_CHECK_TYPES = [GC.REALTIME, GC.TIMEOUT, GC.ERROR];

/**
 * Overlay sample types that FREEZE Confirmation Threshold counting (issue #712):
 * while one is active the count does not advance, and it acts as a hard boundary the
 * pending run cannot cross. Included in the confirmation lookback (unlike MANUAL/DEFAULT,
 * which stay transparent) so the resolver can detect the boundary.
 */
const OVERLAY_TYPES = [GC.INCIDENT, GC.MAINTENANCE];

// **Not the same list as `rollupCompute`'s `OVERLAY_TYPES`, and the difference is
// deliberate (KENER-123).** That one is about provenance - which samples are an
// account of events rather than a measurement - and `OPERATOR` belongs in it.
// This one freezes Confirmation Threshold counting, which is about when alerts
// fire. Adding `OPERATOR` here would change alerting as a side effect of a
// labelling fix, so it stays out and an operator rewrite remains transparent to
// the threshold, exactly as it was while it wrote MANUAL.

/**
 * Repository for monitoring data operations
 */
export class MonitoringRepository extends BaseRepository {
  async insertMonitoringData(data: MonitoringDataInsert): Promise<MonitoringData | null> {
    const { monitor_tag, timestamp, status, latency, type, error_message, raw_status } = data;
    // Defaulted rather than required, because every caller today is the local
    // scheduler writing the merged verdict. A probe reporting for itself passes
    // its own region and lands beside region 0 instead of over it.
    const region_id = data.region_id ?? MERGED_REGION_ID;

    const upsert = this.table("monitoring_data")
      .insert({ monitor_tag, timestamp, region_id, status, latency, type, error_message, raw_status })
      // The conflict target has to be the whole key. Naming only
      // (monitor_tag, timestamp) is what let two regions' samples for one minute
      // merge into a single row, and it failed silently: the merge succeeded,
      // and whichever sample arrived second was simply the one that survived.
      .onConflict(["monitor_tag", "region_id", "timestamp"])
      .merge({ status, latency, type, error_message, raw_status });

    // This runs once per monitor per minute on the worker pool, so the second
    // round trip is worth avoiding. MySQL is the dialect without RETURNING; it
    // re-SELECTs below for the same result.
    if (supportsInsertReturning(this.knexUnscoped)) {
      const rows = (await upsert.returning("*")) as MonitoringData[];
      return rows[0] ?? null;
    }

    await upsert;

    const record = await this.table("monitoring_data")
      .where("monitor_tag", monitor_tag)
      .where("region_id", region_id)
      .where("timestamp", timestamp)
      .first();

    return record as MonitoringData | null;
  }

  async getMonitoringData(monitor_tag: string, start: number, end: number): Promise<MonitoringData[]> {
    return await this.table("monitoring_data")
      .where("monitor_tag", monitor_tag)
      .where("region_id", MERGED_REGION_ID)
      .where("timestamp", ">=", start)
      .where("timestamp", "<", end)
      .orderBy("timestamp", "asc");
  }

  async getLatestMonitoringData(monitor_tag: string): Promise<MonitoringData | undefined> {
    return await this.table("monitoring_data")
      .where("monitor_tag", monitor_tag)
      .where("region_id", MERGED_REGION_ID)
      .orderBy("timestamp", "desc")
      .limit(1)
      .first();
  }

  async getLatestMonitoringDataN(monitor_tag: string, limit: number): Promise<MonitoringData[]> {
    return await this.table("monitoring_data")
      .where("monitor_tag", monitor_tag)
      .where("region_id", MERGED_REGION_ID)
      .orderBy("timestamp", "desc")
      .limit(limit);
  }

  async getMonitoringDataPaginated(
    page: number,
    limit: number,
    filter?: { monitor_tag?: string; status?: MonitoringStatus; start_time?: number; end_time?: number },
  ): Promise<MonitoringData[]> {
    let query = this.table("monitoring_data").select("*").where("region_id", MERGED_REGION_ID);

    if (filter?.monitor_tag) {
      query = query.where("monitor_tag", filter.monitor_tag);
    }

    if (filter?.status) {
      query = query.where("status", filter.status);
    }

    if (filter?.start_time) {
      query = query.where("timestamp", ">=", filter.start_time);
    }

    if (filter?.end_time) {
      query = query.where("timestamp", "<=", filter.end_time);
    }

    return await query
      .orderBy("timestamp", "desc")
      .limit(limit)
      .offset((page - 1) * limit);
  }

  async getMonitoringDataCount(filter?: {
    monitor_tag?: string;
    status?: MonitoringStatus;
    start_time?: number;
    end_time?: number;
  }): Promise<{ count: number }> {
    let query = this.table("monitoring_data").count("* as count").where("region_id", MERGED_REGION_ID);

    if (filter?.monitor_tag) {
      query = query.where("monitor_tag", filter.monitor_tag);
    }

    if (filter?.status) {
      query = query.where("status", filter.status);
    }

    if (filter?.start_time) {
      query = query.where("timestamp", ">=", filter.start_time);
    }

    if (filter?.end_time) {
      query = query.where("timestamp", "<=", filter.end_time);
    }

    const result = await query.first();
    return { count: Number(result?.count) || 0 };
  }

  async getMonitoringDataAt(monitor_tag: string, timestamp: number): Promise<MonitoringData | undefined> {
    return await this.table("monitoring_data")
      .where("monitor_tag", monitor_tag)
      .where("region_id", MERGED_REGION_ID)
      .where("timestamp", timestamp)
      .orderBy("timestamp", "desc")
      .limit(1)
      .first();
  }

  async getLatestMonitoringDataAllActive(monitor_tags: string[]): Promise<MonitoringData[]> {
    if (!monitor_tags || monitor_tags.length === 0) {
      return [];
    }

    // One newest-row lookup per unique tag — each a single descent of the
    // (monitor_tag, region_id, timestamp) primary key. The previous MAX(timestamp)
    // GROUP BY self-join planned as a full-table scan on large
    // monitoring_data tables (Postgres), holding a pool connection for
    // hundreds of ms per page load and exhausting the web pool under load.
    // Lookups run in small batches so a page with many monitors cannot queue
    // more connection acquisitions than the pool can serve at once.
    const uniqueTags = [...new Set(monitor_tags)];
    const batchSize = 10;
    const rows: (MonitoringData | undefined)[] = [];
    for (let i = 0; i < uniqueTags.length; i += batchSize) {
      const batch = uniqueTags.slice(i, i + batchSize);
      rows.push(...(await Promise.all(batch.map((tag) => this.getLatestMonitoringData(tag)))));
    }
    return rows.filter((row): row is MonitoringData => row !== undefined);
  }

  async getLastHeartbeat(monitor_tag: string): Promise<MonitoringData | undefined> {
    return await this.table("monitoring_data")
      .where("monitor_tag", monitor_tag)
      .where("region_id", MERGED_REGION_ID)
      .where("type", GC.SIGNAL)
      .orderBy("timestamp", "desc")
      .limit(1)
      .first();
  }

  async getAggregatedMonitoringData(
    monitor_tag: string,
    start: number,
    end: number,
  ): Promise<AggregatedMonitoringData | undefined> {
    return await this.table("monitoring_data")
      .select(
        this.knexUnscoped.raw("COUNT(CASE WHEN status = 'DEGRADED' THEN 1 END) as DEGRADED"),
        this.knexUnscoped.raw("COUNT(CASE WHEN status = 'UP' THEN 1 END) as UP"),
        this.knexUnscoped.raw("COUNT(CASE WHEN status = 'DOWN' THEN 1 END) as DOWN"),
        this.knexUnscoped.raw("AVG(latency) as avg_latency"),
        this.knexUnscoped.raw("MAX(latency) as max_latency"),
        this.knexUnscoped.raw("MIN(latency) as min_latency"),
      )
      .where("monitor_tag", monitor_tag)
      .where("region_id", MERGED_REGION_ID)
      .where("timestamp", ">=", start)
      .where("timestamp", "<=", end)
      .first();
  }

  async getLastStatusBefore(monitor_tag: string, timestamp: number): Promise<MonitoringData | undefined> {
    return await this.table("monitoring_data")
      .where("monitor_tag", monitor_tag)
      .where("region_id", MERGED_REGION_ID)
      .where("timestamp", "<", timestamp)
      .orderBy("timestamp", "desc")
      .limit(1)
      .first();
  }

  async getLastStatusBeforeAll(monitor_tags: string[], timestamp: number): Promise<MonitoringData | undefined> {
    return await this.table("monitoring_data")
      .whereIn("monitor_tag", monitor_tags)
      .where("region_id", MERGED_REGION_ID)
      .where("timestamp", "<", timestamp)
      .orderBy("timestamp", "desc")
      .limit(1)
      .first();
  }

  async getDataGroupByDayAlternative(
    monitor_tag: string,
    start: number,
    end: number,
  ): Promise<Array<{ timestamp: number; status: string; latency: number }>> {
    return await this.table("monitoring_data")
      .select("timestamp", "status", "latency")
      .where("monitor_tag", monitor_tag)
      .where("region_id", MERGED_REGION_ID)
      .andWhere("timestamp", ">=", start)
      .andWhere("timestamp", "<=", end)
      .orderBy("timestamp", "asc");
  }

  async getLastStatusBeforeCombined(
    monitor_tags_arr: string[],
    timestamp: number,
    minTimestamp: number | null,
  ): Promise<{ timestamp: number; total_entries: number; latency: number; status: string } | undefined> {
    let query = this.table("monitoring_data")
      .select(
        "timestamp",
        this.knexUnscoped.raw("COUNT(*) as total_entries"),
        this.knexUnscoped.raw("AVG(latency) as latency"),
        this.knexUnscoped.raw(`
          CASE 
          WHEN SUM(CASE WHEN status = 'DOWN' THEN 1 ELSE 0 END) > 0 THEN 'DOWN'
          WHEN SUM(CASE WHEN status = 'DEGRADED' THEN 1 ELSE 0 END) > 0 THEN 'DEGRADED'
          ELSE 'UP'
          END as status
        `),
      )
      .whereIn("monitor_tag", monitor_tags_arr)
      .where("region_id", MERGED_REGION_ID);

    if (!!minTimestamp) {
      query = query.whereBetween("timestamp", [minTimestamp, timestamp]);
    } else {
      query = query.where("timestamp", "=", timestamp);
    }

    return await query
      .groupBy("timestamp")
      .havingRaw("COUNT(*) = ?", [monitor_tags_arr.length])
      .orderBy("timestamp", "desc")
      .limit(1)
      .first();
  }

  /**
   * Nightly retention.
   *
   * **No `region_id` predicate, and that is the point.** Every read in this file
   * carries `region_id = 0`, so it would be easy to add one here by symmetry and
   * wrong to: retention prunes history, and a probe's samples are history. Keep
   * them past the cutoff and they become rows nothing renders, nothing merges
   * and nothing ever prunes again - the table would grow without bound in the
   * one dimension no query looks at.
   */
  async background(retentionDays: number = 100): Promise<number> {
    const safeRetentionDays = Math.max(1, Math.floor(retentionDays || 100));
    const cutoffTimestamp = GetMinuteStartNowTimestampUTC() - 86400 * safeRetentionDays;
    return await this.table("monitoring_data").where("timestamp", "<", cutoffTimestamp).del();
  }

  async consecutivelyStatusFor(monitor_tag: string, status: string, lastX: number): Promise<boolean> {
    const result = await this.knexUnscoped
      .with("last_records", (qb: KnexType.QueryBuilder) => {
        qb.select("*")
          .from("monitoring_data")
          .where("monitor_tag", monitor_tag)
          .where("region_id", MERGED_REGION_ID)
          .whereIn("type", ALERT_VISIBLE_TYPES)
          .orderBy("timestamp", "desc")
          .limit(lastX);
      })
      .select(
        this.knexUnscoped.raw(
          "CASE WHEN COUNT(*) <= SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) THEN 1 ELSE 0 END as is_affected",
          [status],
        ),
      )
      .from("last_records")
      .first();

    return result.is_affected === 1;
  }

  async consecutivelyLatencyGreaterThan(
    monitor_tag: string,
    latencyThreshold: number,
    lastX: number,
  ): Promise<boolean> {
    const result = await this.knexUnscoped
      .with("last_records", (qb: KnexType.QueryBuilder) => {
        qb.select("*")
          .from("monitoring_data")
          .where("monitor_tag", monitor_tag)
          .where("region_id", MERGED_REGION_ID)
          .whereIn("type", ALERT_VISIBLE_TYPES)
          .orderBy("timestamp", "desc")
          .limit(lastX);
      })
      .select(
        this.knexUnscoped.raw(
          "CASE WHEN COUNT(*) <= SUM(CASE WHEN latency > ? THEN 1 ELSE 0 END) THEN 1 ELSE 0 END as is_affected",
          [latencyThreshold],
        ),
      )
      .from("last_records")
      .first();

    return result.is_affected === 1;
  }

  async consecutivelyLatencyLessThan(monitor_tag: string, latencyThreshold: number, lastX: number): Promise<boolean> {
    const result = await this.knexUnscoped
      .with("last_records", (qb: KnexType.QueryBuilder) => {
        qb.select("*")
          .from("monitoring_data")
          .where("monitor_tag", monitor_tag)
          .where("region_id", MERGED_REGION_ID)
          .whereIn("type", ALERT_VISIBLE_TYPES)
          .orderBy("timestamp", "desc")
          .limit(lastX);
      })
      .select(
        this.knexUnscoped.raw(
          "CASE WHEN COUNT(*) <= SUM(CASE WHEN latency < ? THEN 1 ELSE 0 END) THEN 1 ELSE 0 END as is_recovered",
          [latencyThreshold],
        ),
      )
      .from("last_records")
      .first();

    return result.is_recovered === 1;
  }

  /**
   * Recent samples the Confirmation Threshold resolver needs, newest first: scheduled-check
   * observations (REALTIME/TIMEOUT/ERROR) plus incident/maintenance overlays. MANUAL pushes
   * and DEFAULT fill are excluded — they stay transparent to the counter. Returns `type` so
   * the resolver can stop at overlay rows (freeze). Observations whose status is NO_DATA are
   * excluded entirely (neutral — they neither advance nor reset the count and must not consume lookback slots).
   */
  async getRecentSamplesForConfirmation(
    monitor_tag: string,
    beforeTs: number,
    limit: number,
  ): Promise<Array<{ timestamp: number; status: string | null; raw_status: string | null; type: string | null }>> {
    return await this.table("monitoring_data")
      .select("timestamp", "status", "raw_status", "type")
      .where("monitor_tag", monitor_tag)
      .where("region_id", MERGED_REGION_ID)
      .where("timestamp", "<", beforeTs)
      .whereIn("type", [...OBSERVED_CHECK_TYPES, ...OVERLAY_TYPES])
      .whereNot("status", GC.NO_DATA)
      .orderBy("timestamp", "desc")
      .limit(limit);
  }

  /**
   * Observed samples in a window, oldest last, for C2c's true-outage-start walk.
   *
   * **Only OBSERVED_CHECK_TYPES, and that filter is the whole correctness of the
   * number it feeds.** `monitoring_data` also holds the overlay rows an incident
   * writes for its own window, so including them would let the incident's
   * declared start decide when the outage started - the arithmetic would measure
   * what an operator typed rather than what the monitors saw, and MTTD would be
   * zero for every incident by construction. MANUAL pushes and DEFAULT_STATUS
   * fill are out for the same reason: neither is an observation.
   *
   * NO_DATA is excluded because a gap in checking is not evidence of anything. A
   * scheduler that was down for an hour must not read as an hour of outage.
   *
   * `floor` bounds the walk. Without it a monitor that has been down since it was
   * created would scan its whole history on every metrics read.
   */
  async getObservedSamplesInWindow(
    monitor_tags: string[],
    floor: number,
    ceiling: number,
  ): Promise<Array<{ monitor_tag: string; timestamp: number; status: string | null }>> {
    if (monitor_tags.length === 0) return [];
    return await this.table("monitoring_data")
      .select("monitor_tag", "timestamp", "status")
      .whereIn("monitor_tag", monitor_tags)
      .where("region_id", MERGED_REGION_ID)
      .where("timestamp", ">=", floor)
      .where("timestamp", "<=", ceiling)
      .whereIn("type", OBSERVED_CHECK_TYPES)
      .whereNot("status", GC.NO_DATA)
      .orderBy("timestamp", "desc");
  }

  /**
   * The committed status of the most recent real scheduled-check observation before `beforeTs`
   * — the Confirmation Threshold "anchor" (the side currently shown). Looks past overlays,
   * MANUAL/DEFAULT, and NO_DATA so a long incident/maintenance window can never hide the anchor
   * (issue #712). Returns null when there is no prior observation (cold start).
   */
  async getLastObservedStatus(monitor_tag: string, beforeTs: number): Promise<string | null> {
    const row = await this.table("monitoring_data")
      .select("status")
      .where("monitor_tag", monitor_tag)
      .where("region_id", MERGED_REGION_ID)
      .where("timestamp", "<", beforeTs)
      .whereIn("type", OBSERVED_CHECK_TYPES)
      .whereNot("status", GC.NO_DATA)
      .orderBy("timestamp", "desc")
      .limit(1)
      .first();
    return row ? (row.status ?? null) : null;
  }

  /**
   * Backfill a confirmed status flip: set each row's committed status to its observed raw_status.
   * `confirmThreshold` is the number of consecutive checks that confirmed the flip — when it is a
   * number the run resolved to an unhealthy side and a per-row note ("Down"/"Degraded confirmed
   * after N consecutive checks", matching each row's own severity) is appended to the existing
   * error text; when it is null the run resolved to UP (recovery) and the error text is cleared.
   */
  async backfillConfirmedStatus(
    monitor_tag: string,
    timestamps: number[],
    confirmThreshold: number | null,
  ): Promise<number> {
    if (timestamps.length === 0) return 0;

    // **The rollup invalidation lives inside this method, not at the call site
    // in `confirmationThreshold.ts`.** A flip restates minutes that are already
    // behind the rollup watermark, so nothing else would ever revisit them - and
    // a future caller of this method would have no reason to know that. Putting
    // the mark here means the only way to rewrite these rows is to invalidate
    // the buckets built from them.
    const dirtyRange = {
      monitor_tag,
      region_id: MERGED_REGION_ID,
      from: Math.min(...timestamps),
      to: Math.max(...timestamps),
    };

    // Recovery (confirmed UP): rows become the UP side — clear any held error text in one update.
    if (confirmThreshold === null) {
      const updated = await this.table("monitoring_data")
        .where("monitor_tag", monitor_tag)
        .where("region_id", MERGED_REGION_ID)
        .whereIn("timestamp", timestamps)
        .whereNotNull("raw_status")
        .update({
          status: this.knexUnscoped.ref("raw_status"),
          error_message: null,
        });
      await markRollupDirty(this.knexUnscoped, [dirtyRange], GetNowTimestampUTC());
      return updated;
    }

    // Confirmed unhealthy: set each row's status from its observed raw_status and APPEND a
    // severity-matched confirmation note to the existing error text (preserving the observed
    // failure reason). Done per-row for portable string concatenation (|| vs CONCAT differ across
    // SQLite/PG/MySQL), per-row severity wording, and idempotency if the backfill is replayed.
    // The whole read+update window runs in one transaction — a confirmation flip is one logical
    // write, so it must not leave the window half-confirmed/half-held if a row update fails.
    return await this.knexUnscoped.transaction(async (trx: KnexType.Transaction) => {
      const rows = await trx("monitoring_data")
        .select("timestamp", "error_message", "raw_status")
        .where("monitor_tag", monitor_tag)
        .where("region_id", MERGED_REGION_ID)
        .whereIn("timestamp", timestamps)
        .whereNotNull("raw_status");

      let updated = 0;
      for (const row of rows) {
        const severity = row.raw_status === GC.DEGRADED ? "Degraded" : "Down";
        const note = `${severity} confirmed after ${confirmThreshold} consecutive checks`;
        const existing: string | null = row.error_message;
        let nextMessage: string;
        if (!existing) {
          nextMessage = note;
        } else if (existing.indexOf(note) !== -1) {
          nextMessage = existing; // already appended — keep idempotent
        } else {
          nextMessage = `${existing} | ${note}`;
        }
        updated += await trx("monitoring_data")
          .where({ monitor_tag, region_id: MERGED_REGION_ID, timestamp: row.timestamp })
          .update({ status: row.raw_status, error_message: nextMessage });
      }
      // Inside the same transaction as the rewrite, so a rollback takes the
      // invalidation with it rather than leaving a bucket marked dirty for a
      // change that never happened.
      await markRollupDirty(trx, [dirtyRange], GetNowTimestampUTC());
      return updated;
    });
  }

  /**
   * Overwrites a window of a monitor's timeline with a fixed status.
   *
   * The admin "update monitoring data" action, and C7's backfill overlay.
   *
   * **`org_id` is stamped explicitly here, and it was missing.** This method
   * writes through `knexUnscoped` rather than the scoped builder - it has to,
   * because it batches inside its own transaction and the scoped proxy is a
   * query builder rather than a transaction - and the scoped builder is also
   * what stamps `org_id` on an insert. So every row this wrote landed with a
   * null org, and `monitoring_data` is a tenant table: every read of it is
   * `where org_id = ?`, which matches no null. The rows existed and nothing
   * could see them.
   *
   * That was true of the admin action before C7 and would have made the whole of
   * C7 silently do nothing visible: the backfill's entire purpose is to put
   * history on the bars, and the bars read through the scoped path.
   */
  async updateMonitoringData(
    monitor_tag: string,
    start: number,
    end: number,
    newStatus: string,
    type: string,
    latency: number = 0,
    deviation: number = 0,
  ): Promise<unknown[]> {
    const count = Math.floor((end - start) / 60) + 1;
    const timestamps = Array.from({ length: count }, (_, i) => start + i * 60);
    const nowTs = GetNowTimestampUTC();

    // Null under `runAsSystem`, which is the deliberate cross-tenant mode. A row
    // written there keeps the null it would have had anyway, rather than being
    // assigned to whichever org happened to be first.
    const orgId = requireOrgId("monitoring_data");

    // Generate random latency as latency ± deviation (never below 0)
    const generateLatency = () => {
      if (deviation === 0) return latency;
      const randomOffset = Math.floor(Math.random() * (deviation * 2 + 1)) - deviation;
      return Math.max(0, latency + randomOffset);
    };

    const records = timestamps.map((ts) => ({
      monitor_tag,
      timestamp: ts,
      // The overlay rewrites the verdict, never a probe's own report of what it
      // saw. A probe's samples are evidence; this is the operator's account.
      region_id: MERGED_REGION_ID,
      status: newStatus,
      type,
      latency: generateLatency(),
      ...(orgId === null ? {} : { org_id: orgId }),
    }));

    const batchSize = 500;

    return await this.knexUnscoped.transaction(async (trx: KnexType.Transaction) => {
      const results: unknown[] = [];

      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        // Use raw insert with ON CONFLICT to update all fields including latency
        // `org_id` is deliberately not in the merge list: an existing row already
        // belongs to an org, and a conflict here means this window is being
        // rewritten rather than reassigned.
        const result = await trx("monitoring_data")
          .insert(batch)
          .onConflict(["monitor_tag", "region_id", "timestamp"])
          .merge(["status", "type", "latency"]);
        results.push(result);
      }

      // Same reasoning as `backfillConfirmedStatus`: this rewrites an arbitrary
      // window that is already behind the watermark, so the buckets over it have
      // to be recomputed and nothing else will notice they should be.
      await markRollupDirty(trx, [{ monitor_tag, region_id: MERGED_REGION_ID, from: start, to: end }], nowTs);

      return results;
    });
  }

  /**
   * Deletes a window of a monitor's samples, and the rollups built from them.
   *
   * **Every region, like `background` and for the same reason.** This is the
   * only path that removes a monitor's history on purpose, so leaving a probe's
   * rows behind would leave orphans that no read returns and no later delete
   * finds.
   *
   * **The rollups are handled two different ways, and which one applies turns on
   * `status`.**
   *
   *   - No status filter: every sample in the window goes, so the buckets over
   *     it are simply *deleted*. There is nothing left to recompute them from,
   *     and marking them dirty would schedule work whose only outcome is to
   *     delete them anyway.
   *   - With a status filter: only some samples go and the rest still need
   *     buckets, so the window is marked dirty as well. The recompute then
   *     rebuilds each bucket from what survived.
   *
   * Both happen in the same transaction as the delete. A crash between deleting
   * samples and deleting their buckets would leave rollups asserting uptime for
   * minutes that no longer exist - the one failure mode where a stale rollup
   * actively lies rather than merely lagging.
   */
  async deleteMonitorDataByTag(tag?: string, start?: number, end?: number, status?: MonitoringStatus): Promise<number> {
    const nowTs = GetNowTimestampUTC();

    return await this.knexUnscoped.transaction(async (trx: KnexType.Transaction) => {
      const scope = (builder: KnexType.QueryBuilder) => {
        if (tag) builder.where("monitor_tag", tag);
        if (start !== undefined) builder.where("timestamp", ">=", start);
        if (end !== undefined) builder.where("timestamp", "<=", end);
        return builder;
      };

      // The affected tags, read before the delete removes the evidence. A
      // tagless call is a bulk delete across every monitor, and each one's
      // buckets have to be found by name.
      const affected: string[] = tag
        ? [tag]
        : (await scope(trx("monitoring_data").distinct("monitor_tag"))).map(
            (row: { monitor_tag: string }) => row.monitor_tag,
          );

      const orgId = requireOrgId("monitoring_data");
      const rollupFrom = start ?? null;
      // Rollup buckets are keyed by their START, so a bucket beginning before
      // `end` can still cover samples up to `end`. The exclusive bound has to be
      // `end + 1` or the last partially-covered bucket survives the delete.
      const rollupTo = end === undefined ? null : end + 1;

      for (const affectedTag of affected) {
        for (const grain of ["5m", "15m", "1h", "1d"] as const) {
          const deleteRollups = trx(ROLLUP_TABLES[grain]).where("monitor_tag", affectedTag);
          if (orgId !== null) deleteRollups.where("org_id", orgId);
          if (rollupFrom !== null) deleteRollups.where("bucket_start", ">=", rollupFrom);
          if (rollupTo !== null) deleteRollups.where("bucket_start", "<", rollupTo);
          await deleteRollups.del();
        }
      }

      const query = scope(trx("monitoring_data"));
      if (orgId !== null) query.where("org_id", orgId);
      if (status) query.where("status", status);
      const removed = await query.del();

      if (status && affected.length > 0 && start !== undefined && end !== undefined) {
        await markRollupDirty(
          trx,
          affected.map((affectedTag) => ({
            monitor_tag: affectedTag,
            region_id: MERGED_REGION_ID,
            from: start,
            to: end,
          })),
          nowTs,
        );
      }

      return removed;
    });
  }

  /**
   * Get aggregated status counts grouped by timestamp intervals
   * @param monitorTag - The monitor tag(s) to query (single string or array of strings)
   * @param startTimestamp - The starting timestamp (UTC seconds)
   * @param intervalInSeconds - The interval size in seconds (e.g., 86400 for 1 day)
   * @param numberOfPoints - Number of intervals/points to return
   * @returns Array of { ts, countOfUp, countOfDown, countOfDegraded }
   */
  async getStatusCountsByInterval(
    monitorTag: string | string[],
    startTimestamp: number,
    intervalInSeconds: number,
    numberOfPoints: number,
  ): Promise<Array<TimestampStatusCount>> {
    const endTimestamp = startTimestamp + numberOfPoints * intervalInSeconds;

    // Determine database client to use appropriate timestamp arithmetic
    // SQLite uses CAST(... as INT), others (PG, MySQL) use FLOOR()
    const tsExpression = hasFloorFunction(this.knexUnscoped)
      ? `FLOOR((timestamp - ?) / ?) * ? + ?`
      : `CAST((timestamp - ?) / ? AS INT) * ? + ?`;

    // Handle single tag or array of tags
    const isArray = Array.isArray(monitorTag);
    const tagClause = isArray ? `monitor_tag IN (${monitorTag.map(() => "?").join(", ")})` : `monitor_tag = ?`;
    // Use snake_case aliases for cross-database compatibility (PostgreSQL lowercases unquoted identifiers)
    const sql = `
      SELECT 
        ${tsExpression} as ts,
        SUM(CASE WHEN status = 'UP' THEN 1 ELSE 0 END) AS count_of_up,
        SUM(CASE WHEN status = 'DOWN' THEN 1 ELSE 0 END) AS count_of_down,
        SUM(CASE WHEN status = 'DEGRADED' THEN 1 ELSE 0 END) AS count_of_degraded,
        SUM(CASE WHEN status = 'MAINTENANCE' THEN 1 ELSE 0 END) AS count_of_maintenance,
        AVG(latency) AS avg_latency,
				MAX(latency) AS max_latency,
				MIN(latency) AS min_latency
      FROM monitoring_data
      WHERE ${tagClause} AND region_id = ? AND timestamp >= ? AND timestamp < ?
      GROUP BY ts
      ORDER BY ts ASC
    `;

    // Bindings:
    // 1-4: tsExpression parameters (start, interval, interval, start)
    // 5+: WHERE clause parameters (tag(s), start, end)
    const bindings = [
      startTimestamp,
      intervalInSeconds,
      intervalInSeconds,
      startTimestamp,
      ...(isArray ? monitorTag : [monitorTag]),
      MERGED_REGION_ID,
      startTimestamp,
      endTimestamp,
    ];

    const result = await this.knexUnscoped.raw(sql, bindings);

    // Handle different database drivers:
    // - SQLite (better-sqlite3): returns array directly
    // - PostgreSQL: returns { rows: [...] }
    // - MySQL: returns [rows, fields] where rows is an array
    let rows: any[];
    if (Array.isArray(result)) {
      // SQLite or MySQL (MySQL returns [rows, fields])
      rows = Array.isArray(result[0]) ? result[0] : result;
    } else {
      // PostgreSQL
      rows = result.rows || [];
    }

    return rows.map((row: any) => ({
      ts: Number(row.ts),
      countOfUp: Number(row.count_of_up) || 0,
      countOfDown: Number(row.count_of_down) || 0,
      countOfDegraded: Number(row.count_of_degraded) || 0,
      countOfMaintenance: Number(row.count_of_maintenance) || 0,
      avgLatency: Number(row.avg_latency) || 0,
      maxLatency: Number(row.max_latency) || 0,
      minLatency: Number(row.min_latency) || 0,
    }));
  }

  /**
   * Get aggregated status counts grouped by monitor_tag and timestamp intervals
   * @param monitorTags - Monitor tags to query
   * @param startTimestamp - The starting timestamp (UTC seconds)
   * @param intervalInSeconds - The interval size in seconds (e.g., 86400 for 1 day)
   * @param numberOfPoints - Number of intervals/points to return
   */
  async getStatusCountsByIntervalGroupedByMonitor(
    monitorTags: string[],
    startTimestamp: number,
    intervalInSeconds: number,
    numberOfPoints: number,
  ): Promise<Array<TimestampStatusCountByMonitor>> {
    if (!monitorTags || monitorTags.length === 0) {
      return [];
    }

    const endTimestamp = startTimestamp + numberOfPoints * intervalInSeconds;

    // SQLite has no FLOOR(); CAST(... AS INT) truncates the same way.
    const tsExpression = hasFloorFunction(this.knexUnscoped)
      ? `FLOOR((timestamp - ?) / ?) * ? + ?`
      : `CAST((timestamp - ?) / ? AS INT) * ? + ?`;

    const sql = `
      SELECT
        monitor_tag,
        ${tsExpression} as ts,
        SUM(CASE WHEN status = 'UP' THEN 1 ELSE 0 END) AS count_of_up,
        SUM(CASE WHEN status = 'DOWN' THEN 1 ELSE 0 END) AS count_of_down,
        SUM(CASE WHEN status = 'DEGRADED' THEN 1 ELSE 0 END) AS count_of_degraded,
        SUM(CASE WHEN status = 'MAINTENANCE' THEN 1 ELSE 0 END) AS count_of_maintenance,
        AVG(latency) AS avg_latency,
        MAX(latency) AS max_latency,
        MIN(latency) AS min_latency
      FROM monitoring_data
      WHERE monitor_tag IN (${monitorTags.map(() => "?").join(", ")}) AND region_id = ? AND timestamp >= ? AND timestamp < ?
      GROUP BY monitor_tag, ts
      ORDER BY monitor_tag ASC, ts ASC
    `;

    const bindings = [
      startTimestamp,
      intervalInSeconds,
      intervalInSeconds,
      startTimestamp,
      ...monitorTags,
      MERGED_REGION_ID,
      startTimestamp,
      endTimestamp,
    ];

    const result = await this.knexUnscoped.raw(sql, bindings);

    let rows: any[];
    if (Array.isArray(result)) {
      rows = Array.isArray(result[0]) ? result[0] : result;
    } else {
      rows = result.rows || [];
    }

    return rows.map((row: any) => ({
      monitor_tag: row.monitor_tag,
      ts: Number(row.ts),
      countOfUp: Number(row.count_of_up) || 0,
      countOfDown: Number(row.count_of_down) || 0,
      countOfDegraded: Number(row.count_of_degraded) || 0,
      countOfMaintenance: Number(row.count_of_maintenance) || 0,
      avgLatency: Number(row.avg_latency) || 0,
      maxLatency: Number(row.max_latency) || 0,
      minLatency: Number(row.min_latency) || 0,
    }));
  }

  /**
   * Get aggregated status counts and average latency for the last N rows
   * @param monitorTag - The monitor tag(s) to query (single string or array of strings)
   * @param lastX - Number of most recent rows to include
   * @returns Object with ts=0, counts of each status, and average latency
   */
  async getStatusCountsForLastN(monitorTag: string | string[], lastX: number): Promise<TimestampStatusCount> {
    const tags = Array.isArray(monitorTag) ? monitorTag : [monitorTag];

    const result = await this.knexUnscoped
      .with("last_records", (qb: KnexType.QueryBuilder) => {
        qb.select("status", "latency")
          .from("monitoring_data")
          .whereIn("monitor_tag", tags)
          .where("region_id", MERGED_REGION_ID)
          .orderBy("timestamp", "desc")
          .limit(lastX);
      })
      .select(
        this.knexUnscoped.raw("SUM(CASE WHEN status = 'UP' THEN 1 ELSE 0 END) AS count_of_up"),
        this.knexUnscoped.raw("SUM(CASE WHEN status = 'DOWN' THEN 1 ELSE 0 END) AS count_of_down"),
        this.knexUnscoped.raw("SUM(CASE WHEN status = 'DEGRADED' THEN 1 ELSE 0 END) AS count_of_degraded"),
        this.knexUnscoped.raw("SUM(CASE WHEN status = 'MAINTENANCE' THEN 1 ELSE 0 END) AS count_of_maintenance"),
        this.knexUnscoped.raw("AVG(latency) AS avg_latency"),
        this.knexUnscoped.raw("MAX(latency) AS max_latency"),
        this.knexUnscoped.raw("MIN(latency) AS min_latency"),
      )
      .from("last_records")
      .first();

    return {
      ts: 0,
      countOfUp: Number(result?.count_of_up) || 0,
      countOfDown: Number(result?.count_of_down) || 0,
      countOfDegraded: Number(result?.count_of_degraded) || 0,
      countOfMaintenance: Number(result?.count_of_maintenance) || 0,
      avgLatency: Number(result?.avg_latency) || 0,
      maxLatency: Number(result?.max_latency) || 0,
      minLatency: Number(result?.min_latency) || 0,
    };
  }

  //get the last known status for a monitor
  async getLastKnownStatus(monitor_tag: string): Promise<MonitoringData | undefined> {
    return await this.table("monitoring_data")
      .where("monitor_tag", monitor_tag)
      .where("region_id", MERGED_REGION_ID)
      .orderBy("timestamp", "desc")
      .first();
  }
}
