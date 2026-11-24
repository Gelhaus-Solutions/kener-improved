import crypto from "node:crypto";
import type { Knex as KnexType } from "knex";
import { BaseRepository } from "./base.js";
import {
  DELTA_TABLES,
  EncodeCursor,
  EXCLUDED_SITE_DATA_KEYS,
  HISTORY_SECONDS,
  IsMirroredSiteDataKey,
  MERGED_REGION,
  MIRRORED_GRAINS,
  OVERLAP_SECONDS,
  PAGE_ROWS,
  PortableRow,
  RAW_MAX_SECONDS,
  RAW_SECONDS,
  SNAPSHOT_TABLES,
  STANDBY_EXPORT_FORMAT,
  SanitizeMonitorRow,
  type DeltaCursor,
  type DeltaTable,
  type Row,
  type SnapshotTable,
  type StandbyExportPage,
} from "../../standby/tables.js";
import {
  ReadStandbyFreshness,
  ResetStandbyFreshnessMemo,
  STANDBY_STATE_ID,
  STANDBY_STATE_TABLE,
  type StandbyFreshness,
  type StandbyStateRow,
} from "../../standby/freshness.js";

/** What one export request asks for. */
export interface StandbyExportRequest {
  /** The data time of the standby's last good pull, 0 for a full copy. */
  since: number;
  after: DeltaCursor | null;
  imagesFingerprint: string | null;
  nowSeconds: number;
  /** Tests only; the endpoint always sends PAGE_ROWS. */
  pageRows?: number;
}

/** What the pull carries from its first page to the page that finishes it. */
export interface StandbyPullContext {
  first: boolean;
  final: boolean;
  dataAt: number;
  schema: string | null;
  imagesFingerprint: string | null;
  nowSeconds: number;
}

export interface StandbyApplyResult {
  rows: number;
  /** Monitors whose rollup rows changed, for the bar cache versions. */
  touchedTags: string[];
  /** Orgs in the snapshot, for the site data cache. */
  orgIds: number[];
}

// Bound parameters per statement stay under every dialect's limit (SQLite 32766).
const MAX_BINDINGS = 30000;
const ID_CHUNK = 500;

/**
 * The standby mirror (docs/v4/setup/standby): the primary's export and the
 * standby's apply.
 *
 * **Every query here is unscoped, on purpose.** A mirror copies every org; the
 * export runs behind the shared token, not an org's session, and the apply
 * writes the rows with the `org_id` they already carry.
 */
export class StandbyRepository extends BaseRepository {
  private readonly columnCache = new Map<string, Set<string>>();

  async getLatestMigrationName(): Promise<string | null> {
    const row = (await this.knexUnscoped("knex_migrations").max({ name: "name" }).first()) as
      | { name: string | null }
      | undefined;
    return row?.name ?? null;
  }

  async getStandbyState(): Promise<StandbyStateRow | null> {
    return ((await this.knexUnscoped(STANDBY_STATE_TABLE).where("id", STANDBY_STATE_ID).first()) ??
      null) as StandbyStateRow | null;
  }

  /** Null on a primary. */
  async getStandbyFreshness(): Promise<StandbyFreshness | null> {
    return await ReadStandbyFreshness(this.knexUnscoped);
  }

  async recordStandbyPullFailure(message: string, nowSeconds: number): Promise<void> {
    await this.knexUnscoped(STANDBY_STATE_TABLE)
      .insert({ id: STANDBY_STATE_ID, last_attempt_at: nowSeconds, last_error: message.slice(0, 2000) })
      .onConflict("id")
      .merge(["last_attempt_at", "last_error"]);
    ResetStandbyFreshnessMemo();
  }

  // ---- export, on the primary ------------------------------------------------

  async exportStandbyPage(request: StandbyExportRequest): Promise<StandbyExportPage> {
    const knex = this.knexUnscoped;
    const now = request.nowSeconds;
    const windows = await this.exportWindows(knex, now);
    const first = request.after === null;

    let snapshot: StandbyExportPage["snapshot"] = null;
    let images: Row[] | null = null;
    let imagesFingerprint: string | null = null;
    if (first) {
      snapshot = await this.exportSnapshot(knex, now);
      imagesFingerprint = await this.imagesFingerprint(knex);
      if (imagesFingerprint !== request.imagesFingerprint) {
        images = (await knex("images").select("*").orderBy("id", "asc")).map(PortableRow);
      }
    }

    const delta: Record<string, Row[]> = {};
    let next: StandbyExportPage["next"] = null;
    let remaining = request.pageRows ?? PAGE_ROWS;
    const start = request.after ?? { t: 0, k: null };
    for (let t = start.t; t < DELTA_TABLES.length; t++) {
      const spec = DELTA_TABLES[t];
      const rows = await this.deltaRows(knex, spec, t === start.t ? start.k : null, request.since, windows, remaining);
      delta[spec.table] = rows.map(PortableRow);
      remaining -= rows.length;
      if (remaining <= 0) {
        const last = rows[rows.length - 1];
        next = EncodeCursor({ t, k: spec.order.map((column) => last[column] as string | number) });
        break;
      }
    }

    return {
      format: STANDBY_EXPORT_FORMAT,
      schema: await this.getLatestMigrationName(),
      generatedAt: now,
      windows,
      snapshot,
      images,
      imagesFingerprint,
      delta,
      next,
    };
  }

  private async exportWindows(knex: KnexType, now: number): Promise<StandbyExportPage["windows"]> {
    // Raw samples must reach back to the oldest watermark a bar reads rollups up to.
    const row = (await knex("rollup_state")
      .min({ watermark: "watermark_ts" })
      .whereIn("grain", MIRRORED_GRAINS)
      .where("region_id", MERGED_REGION)
      .whereNotNull("watermark_ts")
      .first()) as { watermark: number | string | null } | undefined;
    const watermark = row?.watermark === null || row?.watermark === undefined ? null : Number(row.watermark);
    const rawFrom = Math.max(now - RAW_MAX_SECONDS, Math.min(now - RAW_SECONDS, watermark ?? Infinity));
    // A day of margin: a viewer's window ends at the end of their own day.
    return { rawFrom, rollupFrom: now - HISTORY_SECONDS - 86400 };
  }

  private async exportSnapshot(knex: KnexType, now: number): Promise<Partial<Record<SnapshotTable, Row[]>>> {
    const all = async (table: string) => (await knex(table).select("*")).map(PortableRow);
    const cutoff = now - HISTORY_SECONDS;

    // Open, or touched within the history the page shows.
    const incidents = await knex("incidents")
      .select("*")
      .where((w) =>
        w.whereNull("end_date_time").orWhere("end_date_time", ">=", cutoff).orWhere("start_date_time", ">=", cutoff),
      );
    const incidentIds = incidents.map((i: Row) => i.id as number);

    const events = await knex("maintenances_events").select("*").where("end_date_time", ">=", cutoff);
    const maintenanceIds = [...new Set(events.map((e: Row) => e.maintenance_id as number))];

    return {
      orgs: await all("orgs"),
      org_domains: await all("org_domains"),
      site_data: (await knex("site_data").select("*").whereNotIn("key", EXCLUDED_SITE_DATA_KEYS))
        .filter((r: Row) => IsMirroredSiteDataKey(String(r.key)))
        .map(PortableRow),
      pages: await all("pages"),
      pages_monitors: await all("pages_monitors"),
      page_domains: await all("page_domains"),
      monitors: (await knex("monitors").select("*")).map(SanitizeMonitorRow).map(PortableRow),
      component_dependencies: await all("component_dependencies"),
      monitor_rollup_settings: await all("monitor_rollup_settings"),
      sla_targets: await all("sla_targets"),
      sla_evaluations: await all("sla_evaluations"),
      incidents: incidents.map(PortableRow),
      incident_monitors: await this.byIds(knex, "incident_monitors", "incident_id", incidentIds),
      incident_comments: await this.byIds(knex, "incident_comments", "incident_id", incidentIds),
      incident_postmortems: await this.byIds(knex, "incident_postmortems", "incident_id", incidentIds, (q) =>
        q.where("status", "PUBLISHED"),
      ),
      maintenances: await this.byIds(knex, "maintenances", "id", maintenanceIds),
      maintenances_events: events.map(PortableRow),
      maintenance_monitors: await this.byIds(knex, "maintenance_monitors", "maintenance_id", maintenanceIds),
      rollup_state: (
        await knex("rollup_state").select("*").whereIn("grain", MIRRORED_GRAINS).where("region_id", MERGED_REGION)
      ).map(PortableRow),
    };
  }

  private async byIds(
    knex: KnexType,
    table: string,
    column: string,
    ids: number[],
    narrow?: (q: KnexType.QueryBuilder) => KnexType.QueryBuilder,
  ): Promise<Row[]> {
    const out: Row[] = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      let q: KnexType.QueryBuilder = knex(table)
        .select("*")
        .whereIn(column, ids.slice(i, i + ID_CHUNK));
      if (narrow) q = narrow(q);
      out.push(...(await q).map(PortableRow));
    }
    return out;
  }

  /** Changes whenever an image is added, replaced or removed. */
  private async imagesFingerprint(knex: KnexType): Promise<string> {
    const rows = (await knex("images").select("id", "updated_at", "size").orderBy("id", "asc")) as Row[];
    const hash = crypto.createHash("sha256");
    for (const row of rows) hash.update(`${row.id}|${String(PortableRow(row).updated_at)}|${row.size}\n`);
    return hash.digest("hex").slice(0, 32);
  }

  private async deltaRows(
    knex: KnexType,
    spec: DeltaTable,
    after: Array<string | number> | null,
    since: number,
    windows: StandbyExportPage["windows"],
    limit: number,
  ): Promise<Row[]> {
    const changedFrom = since > 0 ? since - OVERLAP_SECONDS : null;
    let q: KnexType.QueryBuilder = knex(spec.table).select("*").where("region_id", MERGED_REGION);
    if (spec.table === "monitoring_data") {
      q = q.where("timestamp", ">=", Math.max(windows.rawFrom, changedFrom ?? windows.rawFrom));
    } else {
      q = q.where("bucket_start", ">=", windows.rollupFrom);
      if (changedFrom !== null) q = q.where("computed_at", ">=", changedFrom);
    }
    if (after) {
      // Keyset, spelled out rather than as a row value so every dialect plans it.
      q = q.where((w) => {
        spec.order.forEach((column, i) => {
          w.orWhere((inner) => {
            for (let j = 0; j < i; j++) inner.where(spec.order[j], after[j]);
            inner.where(column, ">", after[i]);
          });
        });
      });
    }
    for (const column of spec.order) q = q.orderBy(column, "asc");
    return (await q.limit(limit)) as Row[];
  }

  // ---- apply, on the standby -------------------------------------------------

  /**
   * Writes one export page. Idempotent: snapshot tables are replaced, delta rows
   * upserted on their primary key, so a page applied twice leaves what applying
   * it once did. The pull counts as good only once its final page is written.
   */
  async applyStandbyPage(page: StandbyExportPage, pull: StandbyPullContext): Promise<StandbyApplyResult> {
    const touched = new Set<string>();
    const orgIds: number[] = [];
    let rows = 0;

    await this.knexUnscoped.transaction(async (trx) => {
      if (pull.first) {
        if (page.snapshot) {
          const snapshot = page.snapshot;
          for (const table of [...SNAPSHOT_TABLES].reverse()) {
            if (table === "orgs" || !Array.isArray(snapshot[table])) continue;
            // The standby keeps its own instance settings; the primary never sends them.
            const q = trx(table);
            if (table === "site_data") q.whereNotIn("key", EXCLUDED_SITE_DATA_KEYS);
            await q.delete();
          }
          for (const table of SNAPSHOT_TABLES) {
            const tableRows = snapshot[table];
            if (!Array.isArray(tableRows)) continue;
            if (table === "orgs") {
              rows += await this.upsert(trx, "orgs", ["id"], tableRows);
              const ids = tableRows.map((r) => Number(r.id));
              await trx("orgs").whereNotIn("id", ids).delete();
              orgIds.push(...ids);
            } else if (table === "site_data") {
              // New ids: the standby's own rows keep theirs, and nothing refers to one.
              rows += await this.insert(
                trx,
                table,
                tableRows.map(({ id: _id, ...row }) => row),
              );
            } else {
              rows += await this.insert(trx, table, tableRows);
            }
          }
        }
        if (Array.isArray(page.images)) {
          await trx("images").delete();
          rows += await this.insert(trx, "images", page.images);
        }
        await trx("monitoring_data").where("timestamp", "<", page.windows.rawFrom).delete();
        for (const spec of DELTA_TABLES) {
          if (spec.table === "monitoring_data") continue;
          await trx(spec.table).where("bucket_start", "<", page.windows.rollupFrom).delete();
        }
      }

      for (const spec of DELTA_TABLES) {
        const tableRows = page.delta[spec.table];
        if (!Array.isArray(tableRows) || tableRows.length === 0) continue;
        rows += await this.upsert(trx, spec.table, spec.key, tableRows);
        // Cached bars hold sealed rollup buckets only; raw samples are read live.
        if (spec.table !== "monitoring_data") for (const row of tableRows) touched.add(String(row.monitor_tag));
      }

      if (pull.final) {
        await trx(STANDBY_STATE_TABLE)
          .insert({
            id: STANDBY_STATE_ID,
            last_pull_at: pull.nowSeconds,
            data_at: pull.dataAt,
            schema_version: pull.schema,
            images_fingerprint: pull.imagesFingerprint,
            last_attempt_at: pull.nowSeconds,
            last_error: null,
          })
          .onConflict("id")
          .merge();
      }
    });

    if (pull.final) ResetStandbyFreshnessMemo();
    return { rows, touchedTags: [...touched], orgIds };
  }

  /** The target's columns: a dialect's migration may skip one the primary has. */
  private async columnsOf(trx: KnexType.Transaction, table: string): Promise<Set<string>> {
    let columns = this.columnCache.get(table);
    if (!columns) {
      columns = new Set(Object.keys(await trx(table).columnInfo()));
      this.columnCache.set(table, columns);
    }
    return columns;
  }

  private async fit(trx: KnexType.Transaction, table: string, rows: Row[]): Promise<Row[][]> {
    const columns = await this.columnsOf(trx, table);
    const fitted = rows.map((row) => {
      const out: Row = {};
      for (const [column, value] of Object.entries(row)) if (columns.has(column)) out[column] = value;
      return out;
    });
    const width = Math.max(1, columns.size);
    const size = Math.max(1, Math.min(500, Math.floor(MAX_BINDINGS / width)));
    const chunks: Row[][] = [];
    for (let i = 0; i < fitted.length; i += size) chunks.push(fitted.slice(i, i + size));
    return chunks;
  }

  private async insert(trx: KnexType.Transaction, table: string, rows: Row[]): Promise<number> {
    for (const chunk of await this.fit(trx, table, rows)) await trx(table).insert(chunk);
    return rows.length;
  }

  private async upsert(trx: KnexType.Transaction, table: string, key: string[], rows: Row[]): Promise<number> {
    for (const chunk of await this.fit(trx, table, rows)) await trx(table).insert(chunk).onConflict(key).merge();
    return rows.length;
  }
}
