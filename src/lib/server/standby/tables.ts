import { INSTANCE_SCOPED_KEYS } from "../controllers/siteDataScope.js";
import { ROLLUP_TABLES, type RollupGrain } from "../types/db.js";

/**
 * What a standby mirrors, shared by the primary's export and the standby's apply.
 *
 * Snapshot tables are small and sent whole on the first page of every pull; the
 * standby replaces its copy. Delta tables are the time series: sent from a
 * cursor, upserted, and pruned to a window.
 */

export const STANDBY_EXPORT_FORMAT = 1;

/** Rows per export response, across every delta table. */
export const PAGE_ROWS = 5000;

/** Re-read this much before the cursor, for rows committed after a pull read past them. */
export const OVERLAP_SECONDS = 300;

/** The longest the page's bars reach back (monitor-bars caps `days` at 90). */
export const HISTORY_SECONDS = 90 * 86400;

/** Raw samples kept: today's live tail under the daily rollup, with margin. */
export const RAW_SECONDS = 26 * 3600;
/** Never more raw than this, however far a rollup watermark lags. */
export const RAW_MAX_SECONDS = 7 * 86400;

/**
 * The grains a public bar reads: 1d for UTC viewers, 1h for whole-hour offsets,
 * 15m for half- and quarter-hour ones (see `pickGrain`).
 */
export const MIRRORED_GRAINS: RollupGrain[] = ["1d", "1h", "15m"];

export const MERGED_REGION = 0;

export interface DeltaTable {
  table: string;
  /** Keyset order; the first column is the change time the `since` cursor compares. */
  order: string[];
  key: string[];
}

export const DELTA_TABLES: DeltaTable[] = [
  { table: "monitoring_data", order: ["timestamp", "monitor_tag"], key: ["monitor_tag", "region_id", "timestamp"] },
  ...MIRRORED_GRAINS.map((grain) => ({
    table: ROLLUP_TABLES[grain],
    order: ["computed_at", "monitor_tag", "bucket_start"],
    key: ["org_id", "monitor_tag", "region_id", "bucket_start"],
  })),
];

/**
 * Snapshot tables in insert order (parents first); deleted in reverse.
 * `orgs` is upserted instead, because on Postgres every tenant table references it.
 */
export const SNAPSHOT_TABLES = [
  "orgs",
  "org_domains",
  "site_data",
  "pages",
  // Before pages_monitors, which names a monitor by its tag: SQLite checks that foreign key on insert.
  "monitors",
  "pages_monitors",
  "page_domains",
  "component_dependencies",
  "monitor_rollup_settings",
  "sla_targets",
  "sla_evaluations",
  "incidents",
  "incident_monitors",
  "incident_comments",
  "incident_postmortems",
  "maintenances",
  "maintenances_events",
  "maintenance_monitors",
  "rollup_state",
] as const;

export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

/** Instance settings (sign-in, retention, the event bus) the public page never reads. */
export const EXCLUDED_SITE_DATA_KEYS: string[] = [...INSTANCE_SCOPED_KEYS];
const SECRET_LIKE_KEY = /secret|password|token|apikey|api_key|smtp/i;

export function IsMirroredSiteDataKey(key: string): boolean {
  return !EXCLUDED_SITE_DATA_KEYS.includes(key) && !SECRET_LIKE_KEY.test(key);
}

export type Row = Record<string, unknown>;

/** A monitor's check settings can hold credentials; only a group's member list is public. */
export function SanitizeMonitorRow(row: Row): Row {
  return row.monitor_type === "GROUP" ? row : { ...row, type_data: null };
}

/**
 * JSON-safe and dialect-neutral: Postgres hands back json columns as objects and
 * booleans as booleans, which SQLite cannot bind. Dates become ISO strings.
 */
export function PortableRow(row: Row): Row {
  const out: Row = {};
  for (const [column, value] of Object.entries(row)) {
    if (value instanceof Date) out[column] = value.toISOString();
    else if (typeof value === "boolean") out[column] = value ? 1 : 0;
    else if (typeof value === "bigint") out[column] = Number(value);
    else if (value !== null && typeof value === "object" && !Buffer.isBuffer(value))
      out[column] = JSON.stringify(value);
    else out[column] = value;
  }
  return out;
}

export interface DeltaCursor {
  /** Index into DELTA_TABLES. */
  t: number;
  /** The last row's `order` values, or null to start the table. */
  k: Array<string | number> | null;
}

export function EncodeCursor(cursor: DeltaCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Null for anything that is not a cursor this module wrote. */
export function DecodeCursor(raw: string | null | undefined): DeltaCursor | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const { t, k } = parsed as { t?: unknown; k?: unknown };
    if (!Number.isInteger(t) || (t as number) < 0 || (t as number) >= DELTA_TABLES.length) return null;
    if (k === null) return { t: t as number, k: null };
    const order = DELTA_TABLES[t as number].order;
    if (!Array.isArray(k) || k.length !== order.length) return null;
    if (!k.every((v) => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 255))) {
      return null;
    }
    return { t: t as number, k: k as Array<string | number> };
  } catch {
    return null;
  }
}

export interface StandbyExportPage {
  format: number;
  /** The primary's newest applied migration; a standby on another schema refuses the page. */
  schema: string | null;
  /** Primary clock, UTC seconds. */
  generatedAt: number;
  windows: { rawFrom: number; rollupFrom: number };
  /** First page only. */
  snapshot: Partial<Record<SnapshotTable, Row[]>> | null;
  /** First page only, and only when the standby's fingerprint differs. */
  images: Row[] | null;
  imagesFingerprint: string | null;
  delta: Record<string, Row[]>;
  /** Present while more delta rows remain. */
  next: string | null;
}
