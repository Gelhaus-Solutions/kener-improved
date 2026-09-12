// Server-only database types (based on migrations schema)
import type { Knex } from "knex";
import type { PageMonitorLayoutStyle } from "$lib/types/api";

/** Audit column as returned by the driver: Date on pg/mysql, naive UTC text on SQLite. Parse before use. */
export type DbTimestamp = Date | string;

// ============ monitoring_data table ============
export interface MonitoringData {
  monitor_tag: string;
  timestamp: number;
  /** Part of the primary key. 0 is the merged verdict; see `db/regions.ts`. */
  region_id: number;
  status: string | null;
  latency: number | null;
  type: string | null;
  error_message?: string | null;
  raw_status?: string | null;
}

export interface MonitoringDataInsert {
  monitor_tag: string;
  timestamp: number;
  /**
   * Optional, defaulting to the merged verdict (0).
   *
   * Optional rather than required on purpose: every caller today is the local
   * scheduler, whose sample *is* the verdict, and making them all pass a
   * constant would be noise. A probe reporting for itself passes its own id.
   */
  region_id?: number;
  status: string;
  latency: number;
  type: string;
  error_message?: string | null;
  raw_status?: string | null;
}

// ============ monitor_rollup_5m / _1h / _1d tables ============

/**
 * One rollup bucket (F6a).
 *
 * The same shape at all three grains, so folding twelve five-minute rows into an
 * hour and twenty-four hourly rows into a day is one function rather than three.
 *
 * `latency_p50` and friends are **derived, not authoritative**. They exist so the
 * common single-bucket read never parses JSON; anything spanning more than one
 * bucket must merge `latency_histogram` and re-derive, because percentiles do
 * not average. See `services/latencyHistogram.ts`.
 */
export interface MonitorRollup {
  org_id: number;
  monitor_tag: string;
  region_id: number;
  bucket_start: number;

  count_total: number;
  count_up: number;
  count_down: number;
  count_degraded: number;
  count_maintenance: number;
  /** Deliberately separate from a missing row: this is "recorded nothing", not "was not there". */
  count_no_data: number;

  count_in_maint_window: number;
  count_total_excl_maint: number;
  count_up_excl_maint: number;
  count_down_excl_maint: number;
  count_degraded_excl_maint: number;

  /** Rows a check produced. */
  count_observed: number;
  /** Rows an operator wrote: an incident or maintenance overlay, or a backfill. */
  count_overlay: number;

  latency_count: number;
  latency_sum: number;
  latency_min: number | null;
  latency_max: number | null;
  latency_p50: number | null;
  latency_p90: number | null;
  latency_p95: number | null;
  latency_p99: number | null;
  /** Sparse JSON, bucket index to count. Decode with `decodeHistogram`. */
  latency_histogram: string | null;

  /** The real extent of the samples inside the bucket, not the bucket's bounds. */
  first_ts: number | null;
  last_ts: number | null;
  computed_at: number;
  rollup_version: number;
}

/**
 * A rollup row on its way in, before the org is known.
 *
 * `org_id` is stamped by `BaseRepository.table()` at insert time, so the compute
 * layer must NOT carry one. Passing `org_id: 0` as a placeholder would be worse
 * than omitting it: the stamp spreads the row over the org (`{ org_id, ...row }`),
 * so an explicit value wins and every rollup would land in org 0, which no
 * scoped read can see.
 */
export type MonitorRollupInput = Omit<MonitorRollup, "org_id">;

/**
 * The four grains, and the table each lives in.
 *
 * `15m` exists for one reason (KENER-124): the read path must use a grain whose
 * bucket divides the viewer's UTC offset, and 3600 does not divide +05:30. 900
 * divides every offset in use, so a quarter-hour grain serves every real viewer
 * without falling to `5m`.
 */
export const ROLLUP_TABLES = {
  "5m": "monitor_rollup_5m",
  "15m": "monitor_rollup_15m",
  "1h": "monitor_rollup_1h",
  "1d": "monitor_rollup_1d",
} as const;

export type RollupGrain = keyof typeof ROLLUP_TABLES;

/** Bucket width in seconds, per grain. */
export const ROLLUP_GRAIN_SECONDS: Record<RollupGrain, number> = {
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "1d": 86400,
};

export interface AggregatedMonitoringData {
  DEGRADED: number;
  UP: number;
  DOWN: number;
  avg_latency: number | null;
  max_latency: number | null;
  min_latency: number | null;
}

// ============ monitor_alerts table ============
export interface MonitorAlert {
  id: number;
  monitor_tag: string;
  monitor_status: string;
  alert_status: string;
  health_checks: number;
  incident_number: number;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface MonitorAlertInsert {
  monitor_tag: string;
  monitor_status: string;
  alert_status: string;
  health_checks: number;
  config_id?: number;
}

// ============ site_data table ============
export interface SiteData {
  id: number;
  /**
   * The layer this row belongs to (I3b, I3g).
   *
   * `0` is the instance layer, which every org reads through; anything else is
   * that org's own override. The column arrived with I3b and the type never
   * gained it, so the overlay could not be written without a cast.
   */
  org_id: number;
  key: string;
  value: string;
  data_type: string;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

// ============ monitors table ============
export interface MonitorRecord {
  id: number;
  tag: string;
  /**
   * The per-org public name (I3e). Nullable in the schema: the migration
   * backfilled it to `tag` for every existing row, but the column was added
   * nullable and nothing has made it NOT NULL since.
   */
  slug?: string | null;
  name: string;
  description: string | null;
  image: string | null;
  cron: string | null;
  default_status: string;
  status: string | null;
  category_name: string | null;
  monitor_type: string;
  down_trigger?: string | null;
  degraded_trigger?: string | null;
  type_data?: string | null;
  external_url?: string | null;
  day_degraded_minimum_count?: number | null;
  day_down_minimum_count?: number | null;
  confirmation_threshold?: number | null;
  include_degraded_in_downtime?: string;
  is_hidden: string;
  monitor_settings_json: string | null;
  created_at?: DbTimestamp;
  updated_at?: DbTimestamp;
}
export interface MonitorSharingOptions {
  showShareBadgeMonitor: boolean;
  showShareEmbedMonitor: boolean;
}
export interface MonitorSettings {
  uptime_formula_numerator?: string;
  uptime_formula_denominator?: string;
  /**
   * B5. Latency-based DEGRADED. `mode` decides how this relates to the
   * instance-wide default in `site_data.latencyThresholdDefault`: CUSTOM uses
   * the values here, OFF disables escalation for this monitor whatever the
   * default says, and INHERIT (also what an absent setting means) uses it.
   * See services/latencyThreshold.ts.
   */
  latency_threshold?: {
    mode?: "INHERIT" | "OFF" | "CUSTOM";
    enabled?: boolean;
    metric?: "p50" | "p90" | "p95" | "p99" | "avg";
    window_minutes?: number;
    min_samples?: number;
    degraded_ms?: number;
    down_ms?: number | null;
  };
  monitor_status_history_days?: {
    desktop: number;
    mobile: number;
  };
  sharing_options?: MonitorSharingOptions;
}

export interface TimestampStatusCount {
  ts: number;
  countOfUp: number;
  countOfDown: number;
  countOfDegraded: number;
  countOfMaintenance: number;
  avgLatency: number;
  maxLatency: number;
  minLatency: number;
}

export interface TimestampStatusCountByMonitor extends TimestampStatusCount {
  monitor_tag: string;
}
export interface UptimeCalculatorResult {
  uptime: string;
  avgLatency: string;
  maxLatency: string;
  minLatency: string;
}

export interface MonitorRecordTyped {
  id: number;
  tag: string;
  /**
   * The per-org public name (I3e), which is what a link to this monitor carries.
   * Identical to `tag` on the default org, whose `tag_prefix` is empty.
   *
   * Optional because `MonitorRecord` carries it optionally and this type is
   * built by spreading one; a reader wanting a URL should use `slug || tag`.
   */
  slug?: string | null;
  name: string;
  description: string | null;
  image: string | null;
  cron: string | null;
  default_status: string | null;
  status: string | null;
  category_name: string | null;
  monitor_type: string;
  down_trigger?: string | null;
  degraded_trigger?: string | null;
  type_data: Record<string, unknown> | null;
  day_degraded_minimum_count?: number | null;
  day_down_minimum_count?: number | null;
  confirmation_threshold?: number | null;
  include_degraded_in_downtime?: string;
  is_hidden: string;
  monitor_settings_json: MonitorSettings | null;
  created_at?: DbTimestamp;
  updated_at?: DbTimestamp;
  external_url?: string | null;
}

export interface MonitorRecordInsert {
  tag: string;
  /**
   * The per-org public name (I3e). Optional here and defaulted to `tag` by the
   * repository, but callers with org context should derive it properly: on an
   * org with a `tag_prefix`, `tag` is `<prefix>_<slug>` and the slug is the part
   * after the prefix.
   */
  slug?: string | null;
  name: string;
  description?: string | null;
  image?: string | null;
  cron?: string | null;
  default_status?: string | null;
  status?: string | null;
  category_name?: string | null;
  monitor_type?: string | null;
  down_trigger?: string | null;
  degraded_trigger?: string | null;
  type_data?: string | null;
  day_degraded_minimum_count?: number | null;
  day_down_minimum_count?: number | null;
  confirmation_threshold?: number | null;
  include_degraded_in_downtime?: string;
  is_hidden?: string;
  monitor_settings_json?: string | null;
  external_url?: string | null;
}

// ============ triggers table ============
export interface TriggerRecord {
  id: number;
  name: string;
  trigger_type: string | null;
  trigger_desc: string | null;
  trigger_status: string | null;
  trigger_meta: string;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

// Template JSON types for each template type
export interface EmailTemplateJson {
  email_subject: string;
  email_body: string; // HTML string
  to: string;
  from: string;
}

export interface WebhookTemplateJson {
  webhook_body: string; // JSON string
  headers: TriggerHeader[];
  url: string;
}

export interface SlackTemplateJson {
  slack_body: string; // JSON string
  url: string;
}

export interface DiscordTemplateJson {
  discord_body: string; // JSON string
  url: string;
}

export interface TriggerHeader {
  key: string;
  value: string;
}
export interface TriggerMeta extends EmailTemplateJson, WebhookTemplateJson, SlackTemplateJson, DiscordTemplateJson {}

export interface TriggerRecordInsert {
  name: string;
  trigger_type?: string | null;
  trigger_desc?: string | null;
  trigger_status?: string | null;
  trigger_meta?: string | null;
}

// ============ general_email_templates table ============
export interface GeneralEmailTemplateRecord {
  template_id: string;
  template_subject: string | null;
  template_html_body: string | null;
  template_text_body: string | null;
}

export interface GeneralEmailTemplateRecordInsert {
  template_id: string;
  template_subject?: string | null;
  template_html_body?: string | null;
  template_text_body?: string | null;
}

// ============ users table ============
export interface UserRecord {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  is_active: number;
  is_verified: number;
  auth_provider: "local" | "oidc";
  oidc_sub: string | null;
  role_ids: string[]; // Array of role IDs
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface UserRecordInsert {
  email: string;
  name: string;
  password_hash: string;
  role_ids: string[]; // Array of role IDs
  is_active?: number;
  is_verified?: number;
  is_owner?: string;
  auth_provider?: "local" | "oidc";
  oidc_sub?: string | null;
}

export interface UserRecordPublic {
  id: number;
  email: string;
  name: string;
  is_active: number;
  is_verified: number;
  is_owner: string;
  auth_provider: "local" | "oidc";
  oidc_sub: string | null;
  role_ids: string[];
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}
export interface UserRecordDashboard extends UserRecordPublic {
  has_password: boolean;
}

// ============ oidc_group_role_mappings table ============
export interface OidcGroupRoleMappingRecord {
  id: number;
  oidc_group: string;
  role_id: string;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface OidcGroupRoleMappingInsert {
  oidc_group: string;
  role_id: string;
}

// ============ roles table ============
export interface RoleRecord {
  id: string;
  role_name: string;
  readonly: number;
  status: string;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface RolePermissionRecord {
  roles_id: string;
  permissions_id: string;
  status: string;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface UserRoleRecord {
  roles_id: string;
  users_id: number;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

// ============ api_keys table ============
export interface ApiKeyRecord {
  id: number;
  name: string;
  hashed_key: string;
  masked_key: string;
  status: string;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
  /** JSON array of permission ids, or `["*"]`. Read through `parseScopes`. */
  scopes: string;
  expires_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  created_by: number | null;
  rotated_from: number | null;
  revoked_at: number | null;
  key_prefix: string | null;
  org_id: number | null;
}

/**
 * An API key as the admin screen is allowed to see it.
 *
 * `hashed_key` is absent by construction rather than by the caller remembering
 * to delete it. It is an HMAC an offline attacker can test guesses against, and
 * nothing outside authentication has any use for it, so it must not travel to a
 * browser on the strength of `api_keys.read`.
 */
export type ApiKeyRecordPublic = Omit<ApiKeyRecord, "hashed_key">;

export interface ApiKeyRecordInsert {
  name: string;
  hashed_key: string;
  masked_key: string;
  status?: string;
  scopes?: string;
  expires_at?: number | null;
  created_by?: number | null;
  rotated_from?: number | null;
  key_prefix?: string | null;
  org_id?: number | null;
}

// ============ incidents table ============
export interface IncidentRecord {
  id: number;
  title: string;
  start_date_time: number;
  end_date_time: number | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
  status: string;
  state: string;
  incident_type: string;
  incident_source: string;
  is_global: string;
  /** Customer impact (C2): NONE | MAINTENANCE | MINOR | MAJOR | CRITICAL. */
  severity: string;
  /** When `severity` last moved, in UTC seconds. Null until it first changes. */
  severity_changed_at: number | null;
  /** Pins the whole incident's component impact. Null means derive it. */
  impact_override: string | null;
  /** C7: YES on an imported historical incident, so it mails nobody. */
  suppress_notifications: string;
  /** C4: the template this incident was opened from, if any. */
  template_id: number | null;
  /**
   * C2c lifecycle timestamps, all UTC seconds and all nullable.
   *
   * Null means "this never happened", not "unknown": an incident nobody
   * acknowledged has a null `acknowledged_at` forever, and the metrics say so
   * rather than substituting a plausible number.
   */
  detected_at: number | null;
  acknowledged_at: number | null;
  acknowledged_by_user_id: number | null;
  identified_at: number | null;
  mitigated_at: number | null;
  resolved_at: number | null;
}

export interface IncidentMonitorImpact {
  monitor_tag: string;
  /**
   * The per-org public name (I3e). **What a link to this monitor must carry**,
   * because `monitor_tag` holds the org's `tag_prefix` and a visitor should
   * never be shown another tenant's prefix. Identical to the tag on the default
   * org, whose prefix is empty.
   */
  monitor_slug: string;
  monitor_impact: string;
  monitor_name: string;
  monitor_image: string | null;
}

export interface IncidentForMonitorList {
  id: number;
  title: string;
  start_date_time: number;
  end_date_time: number | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
  status: string;
  state: string;
  monitors: IncidentMonitorImpact[];
}

export interface IncidentForMonitorListWithComments extends IncidentForMonitorList {
  comments: IncidentCommentRecord[];
}

export interface IncidentRecordInsert {
  title: string;
  start_date_time: number;
  end_date_time?: number | null;
  status?: string;
  state?: string;
  incident_type?: string;
  incident_source?: string;
  is_global?: string;
  severity?: string;
  impact_override?: string | null;
  suppress_notifications?: string;
  template_id?: number | null;
  /** C2c. Set at creation by the alerting queue, which knows when it observed. */
  detected_at?: number | null;
  /** C7 backfill writes the historical lifecycle straight in. */
  acknowledged_at?: number | null;
  acknowledged_by_user_id?: number | null;
  identified_at?: number | null;
  mitigated_at?: number | null;
  resolved_at?: number | null;
}

// ============ incident_monitors table ============
export interface IncidentMonitorRecord {
  id: number;
  monitor_tag: string;
  monitor_impact: string | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
  incident_id: number;
}

export interface IncidentMonitorRecordInsert {
  monitor_tag: string;
  /** Derived from `component_impact`; never set by a caller directly (C2). */
  monitor_impact?: string | null;
  /** The communication layer, and the value a user actually chooses. */
  component_impact?: string | null;
  incident_id: number;
}

export interface IncidentMonitorDetailRecord {
  id: number;
  monitor_tag: string;
  /** The per-org public name (I3e). See `IncidentMonitorImpact.monitor_slug`. */
  monitor_slug: string | null;
  monitor_impact: string | null;
  monitor_name: string;
  monitor_image: string | null;
  monitor_description: string | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
  incident_id: number;
}

// ============ incident_comments table ============
export interface IncidentCommentRecord {
  id: number;
  comment: string;
  incident_id: number;
  commented_at: number;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
  status: string;
  state: string;
}

// ============ Filter types ============
export interface IncidentFilter {
  status?: string;
  start?: number;
  end?: number;
  state?: string;
  id?: number;
  incident_type?: string;
  incident_source?: string;
}

export interface TriggerFilter {
  status?: string;
}

// ============ Count result ============
export interface CountResult {
  count: number | string;
}

// ============ images table ============
export interface ImageRecord {
  id: string;
  data: string; // base64 encoded image data
  mime_type: string;
  original_name: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface ImageRecordInsert {
  id: string;
  data: string;
  mime_type: string;
  original_name?: string | null;
  width?: number | null;
  height?: number | null;
  size?: number | null;
}

// ============ pages table ============
export interface PageRecord {
  id: number;
  page_path: string;
  page_title: string;
  page_header: string;
  page_subheader: string | null;
  page_logo: string | null;
  page_settings_json: string | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface PageRecordInsert {
  page_path: string;
  page_title: string;
  page_header: string;
  page_subheader?: string | null;
  page_logo?: string | null;
  page_settings_json?: string | null;
}

/**
 * G1: the status filter chips on the public page.
 *
 * Off by default, and that is a deliberate cost. Every setting in this block is
 * presentation on a page that is already live and already public, so shipping it
 * on would grow a new control row on every existing status page the moment the
 * deploy lands. Nobody asked for that, and a status page is the one screen where
 * an unexplained change reads as something being wrong.
 */
export interface PageStatusFilterSettings {
  enabled: boolean;
}

/**
 * G2: how monitors are grouped on the public page.
 *
 * **A category group is not a GROUP monitor, and the UI must not let them read
 * as the same thing.** A `GROUP` monitor is a synthetic monitor that computes its
 * own status from members and has its own bar; a category group here is a purely
 * visual section over `monitors.category_name`. Conflating the two is the source
 * of most of the upstream confusion, so they are labelled differently and a
 * category section never renders as a bar.
 *
 * `mode: "none"` is the default and reproduces today's flat list exactly, for the
 * same reason `status_filter` is off by default.
 */
export interface PageGroupDisplaySettings {
  mode: "none" | "category";
  /** Sections render collapsed on first paint. */
  collapsed_by_default: boolean;
  /** Show each section's worst-of-members status beside its header. */
  show_group_summary: boolean;
}

/**
 * G3: whether this page appears in the public page switcher.
 *
 * An opt-*out*, so every page that predates the flag keeps appearing and the
 * switcher does not quietly shrink on deploy. It hides a page from navigation
 * only; the page itself stays reachable at its own path, because this is a
 * navigation preference and not an access control.
 */
export interface PageSwitcherSettings {
  listed: boolean;
}

export interface PageSettingsType {
  monitor_status_history_days: {
    desktop: number;
    mobile: number;
  };
  monitor_layout_style: PageMonitorLayoutStyle;
  status_filter: PageStatusFilterSettings;
  group_display: PageGroupDisplaySettings;
  switcher: PageSwitcherSettings;
  metaPageTitle?: string;
  metaPageDescription?: string;
  socialPagePreviewImage?: string;
}

export interface PageRecordTyped {
  id: number;
  page_path: string;
  page_title: string;
  page_header: string;
  page_subheader: string | null;
  page_logo: string | null;
  page_settings: PageSettingsType | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

// ============ pages_monitors table ============
export interface PageMonitorRecord {
  page_id: number;
  monitor_tag: string;
  monitor_settings_json: string | null;
  position: number;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface PageMonitorRecordInsert {
  page_id: number;
  monitor_tag: string;
  monitor_settings_json?: string | null;
  position?: number;
}

export interface PageMonitorRecordTyped {
  page_id: number;
  monitor_tag: string;
  monitor_settings: Record<string, unknown> | null;
  position: number;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

// ============ Page Filter ============
export interface PageFilter {
  id?: number;
  page_path?: string;
}

// ============ maintenances table ============
// Uses iCalendar RRULE for scheduling
// Reference: http://www.kanzaki.com/docs/ical/rrule.html
export interface MaintenanceRecord {
  /** D4. YES when this window silences alerting, which is the default. */
  suppress_alerts?: string;
  id: number;
  title: string;
  description: string | null;
  start_date_time: number; // Unix timestamp - when the first occurrence starts
  rrule: string; // iCalendar RRULE string (e.g., FREQ=WEEKLY;BYDAY=SU or FREQ=MINUTELY;COUNT=1)
  duration_seconds: number; // Duration of each maintenance window in seconds
  status: "ACTIVE" | "INACTIVE";
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
  is_global: string;
}

export interface MaintenanceRecordInsert {
  /** D4. YES silences alerting for the window, NO keeps paging through it. */
  suppress_alerts?: string;
  title: string;
  description?: string | null;
  start_date_time: number;
  rrule: string;
  duration_seconds: number;
  status?: "ACTIVE" | "INACTIVE";
  is_global?: string;
}

// ============ maintenance_monitors table ============
export interface MaintenanceMonitorRecord {
  id: number;
  maintenance_id: number;
  monitor_tag: string;
  monitor_impact: "UP" | "DOWN" | "DEGRADED" | "MAINTENANCE";
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface MaintenanceMonitorDetailRecord {
  id: number;
  maintenance_id: number;
  monitor_tag: string;
  monitor_impact: "UP" | "DOWN" | "DEGRADED" | "MAINTENANCE";
  monitor_name: string;
  monitor_image: string | null;
  monitor_description: string | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface MaintenanceMonitorDetailRecord {
  id: number;
  maintenance_id: number;
  monitor_tag: string;
  monitor_impact: "UP" | "DOWN" | "DEGRADED" | "MAINTENANCE";
  monitor_name: string;
  monitor_image: string | null;
  monitor_description: string | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface MaintenanceMonitorRecordInsert {
  maintenance_id: number;
  monitor_tag: string;

  monitor_impact?: "UP" | "DOWN" | "DEGRADED" | "MAINTENANCE";
}

// ============ maintenances_events table ============
export interface MaintenanceEventRecord {
  id: number;
  maintenance_id: number;
  start_date_time: number;
  end_date_time: number;
  status: "SCHEDULED" | "READY" | "ONGOING" | "COMPLETED" | "CANCELLED";
  /**
   * Bumped by the repository on every status write. Part of the event bus
   * idempotency key, so a genuine re-entry into a status is not mistaken for a
   * retry. See migrations/20260908170000_add_maintenance_event_transition_seq.ts
   */
  transition_seq: number;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface MaintenanceEventRecordDetailed {
  id: number;
  maintenance_id: number;
  start_date_time: number;
  end_date_time: number;
  status: "SCHEDULED" | "READY" | "ONGOING" | "COMPLETED" | "CANCELLED";
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
  title: string;
  description: string | null;
}

export interface MaintenanceEventRecordInsert {
  maintenance_id: number;
  start_date_time: number;
  end_date_time: number;
  status?: "SCHEDULED" | "READY" | "ONGOING" | "COMPLETED" | "CANCELLED";
}

// ============ Maintenance Filter ============
export interface MaintenanceFilter {
  id?: number;
  status?: "ACTIVE" | "INACTIVE";
}

export interface MaintenanceEventFilter {
  id?: number;
  maintenance_id?: number;
  status?: "SCHEDULED" | "READY" | "ONGOING" | "COMPLETED" | "CANCELLED";
}

export interface MaintenanceMonitorImpact {
  monitor_tag: string;
  /**
   * The per-org public name (I3e). **What a link to this monitor must carry**,
   * because `monitor_tag` holds the org's `tag_prefix` and a visitor should
   * never be shown another tenant's prefix. Identical to the tag on the default
   * org, whose prefix is empty.
   */
  monitor_slug: string;
  monitor_name: string;
  monitor_image: string | null;
  monitor_impact: string;
}

export interface MaintenanceEventsMonitorList {
  id: number;
  title: string;
  status: string;
  description: string | null;
  start_date_time: number; // Unix timestamp - when the first occurrence starts
  end_date_time: number; // Unix timestamp - when the first occurrence ends
  is_global: YesNoType; // "YES" when the maintenance affects all monitors (no per-monitor rows)
  monitors: MaintenanceMonitorImpact[];
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

// ============ monitor_alerts_config table ============
// SLO_BURN_RATE (F1b) watches an `sla_targets` row rather than monitors, so a
// config carrying it uses `sla_target_id` and the burn_* columns instead of the
// `monitor_alerts_config_monitors` junction and `alert_value`.
export type AlertForType = "STATUS" | "LATENCY" | "UPTIME" | "SLO_BURN_RATE";
export type AlertSeverityType = "CRITICAL" | "WARNING";
export type YesNoType = "YES" | "NO";

export interface MonitorAlertConfigRecord {
  id: number;
  monitor_tag: string | null;
  alert_for: AlertForType;
  alert_value: string;
  failure_threshold: number;
  success_threshold: number;
  alert_description: string | null;
  create_incident: YesNoType;
  is_active: YesNoType;
  severity: AlertSeverityType;
  /** F1b. Set only when alert_for is SLO_BURN_RATE. */
  sla_target_id: number | null;
  burn_window_a: string | null;
  burn_threshold_a: number | null;
  burn_window_b: string | null;
  burn_threshold_b: number | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface MonitorAlertConfigInsert {
  monitor_tag?: string | null;
  alert_for: AlertForType;
  alert_value: string;
  failure_threshold: number;
  success_threshold: number;
  alert_description?: string | null;
  create_incident?: YesNoType;
  is_active?: YesNoType;
  severity?: AlertSeverityType;
  sla_target_id?: number | null;
  burn_window_a?: string | null;
  burn_threshold_a?: number | null;
  burn_window_b?: string | null;
  burn_threshold_b?: number | null;
}

export interface MonitorAlertConfigUpdate {
  alert_for?: AlertForType;
  alert_value?: string;
  failure_threshold?: number;
  success_threshold?: number;
  alert_description?: string | null;
  create_incident?: YesNoType;
  is_active?: YesNoType;
  severity?: AlertSeverityType;
  sla_target_id?: number | null;
  burn_window_a?: string | null;
  burn_threshold_a?: number | null;
  burn_window_b?: string | null;
  burn_threshold_b?: number | null;
}

export interface MonitorAlertConfigFilter {
  id?: number;
  monitor_tag?: string;
  alert_for?: AlertForType;
  is_active?: YesNoType;
}

// ============ monitor_alerts_config_triggers table ============
export interface MonitorAlertConfigTriggerRecord {
  monitor_alerts_id: number;
  trigger_id: number;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface MonitorAlertConfigTriggerInsert {
  monitor_alerts_id: number;
  trigger_id: number;
}

// ============ monitor_alerts_config_monitors table ============
export interface MonitorAlertConfigMonitorRecord {
  monitor_alerts_id: number;
  monitor_tag: string;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface MonitorAlertConfigMonitorInsert {
  monitor_alerts_id: number;
  monitor_tag: string;
}

// ============ Composite types for monitor_alerts_config ============
export interface MonitorAlertConfigWithTriggers extends MonitorAlertConfigRecord {
  triggers: TriggerRecord[];
  monitor_tags: string[];
}

export interface MonitorAlertConfigCreateInput {
  /**
   * Required for every alert_for except SLO_BURN_RATE, which watches an
   * `sla_targets` row instead and carries `sla_target_id`.
   */
  monitor_tags?: string[];
  alert_for: AlertForType;
  alert_value: string;
  failure_threshold: number;
  success_threshold: number;
  alert_description?: string | null;
  create_incident?: YesNoType;
  is_active?: YesNoType;
  severity?: AlertSeverityType;
  trigger_ids?: number[];
  /** F1b, SLO_BURN_RATE only. */
  sla_target_id?: number | null;
  burn_window_a?: string | null;
  burn_threshold_a?: number | null;
  burn_window_b?: string | null;
  burn_threshold_b?: number | null;
}

export interface MonitorAlertConfigUpdateInput {
  id: number;
  monitor_tags?: string[];
  alert_for?: AlertForType;
  alert_value?: string;
  failure_threshold?: number;
  success_threshold?: number;
  alert_description?: string | null;
  create_incident?: YesNoType;
  is_active?: YesNoType;
  severity?: AlertSeverityType;
  trigger_ids?: number[];
  /** F1b, SLO_BURN_RATE only. */
  sla_target_id?: number | null;
  burn_window_a?: string | null;
  burn_threshold_a?: number | null;
  burn_window_b?: string | null;
  burn_threshold_b?: number | null;
}

// ============ monitor_alerts_v2 table ============
export type MonitorAlertStatusType = "TRIGGERED" | "RESOLVED";

export interface MonitorAlertV2Record {
  id: number;
  config_id: number;
  monitor_tag: string | null;
  incident_id: number | null;
  alert_status: MonitorAlertStatusType;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface MonitorAlertV2Insert {
  config_id: number;
  monitor_tag?: string | null;
  incident_id?: number | null;
  alert_status: MonitorAlertStatusType;
}

export interface MonitorAlertV2Update {
  monitor_tag?: string | null;
  incident_id?: number | null;
  alert_status?: MonitorAlertStatusType;
}

export interface MonitorAlertV2Filter {
  id?: number;
  config_id?: number;
  monitor_tag?: string;
  incident_id?: number;
  alert_status?: MonitorAlertStatusType;
}

// Composite type with config details
export interface MonitorAlertV2WithConfig extends MonitorAlertV2Record {
  config: MonitorAlertConfigRecord;
}

// ============ subscription_config table ============
export interface SubscriptionEventsEnabled {
  incidentUpdatesAll: boolean;
  maintenanceUpdatesAll: boolean;
  monitorUpdatesAll: boolean;
}

export interface SubscriptionMethodsEnabled {
  email: boolean;
  webhook: boolean;
  slack: boolean;
  discord: boolean;
}

export interface SubscriptionMethodTriggers {
  email: number | null;
  webhook: number | null;
  slack: number | null;
  discord: number | null;
}

export interface SubscriptionConfigRecord {
  id: number;
  events_enabled: string;
  methods_enabled: string;
  method_triggers: string;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface SubscriptionConfigParsed {
  id: number;
  events_enabled: SubscriptionEventsEnabled;
  methods_enabled: SubscriptionMethodsEnabled;
  method_triggers: SubscriptionMethodTriggers;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface SubscriptionConfigUpdate {
  events_enabled?: string;
  methods_enabled?: string;
  method_triggers?: string;
}

// ============ New Subscription System (v2) ============

export type SubscriptionMethodType = "email";
export type SubscriptionEventType = "incidents" | "maintenances";
export type SubscriptionStatus = "ACTIVE" | "INACTIVE";
export type SubscriberUserStatus = "PENDING" | "ACTIVE" | "INACTIVE";

// ============ subscriber_users table ============
export interface SubscriberUserRecord {
  id: number;
  email: string;
  status: SubscriberUserStatus;
  verification_code: string | null;
  verification_expires_at: Date | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface SubscriberUserRecordInsert {
  email: string;
  status?: SubscriberUserStatus;
  verification_code?: string | null;
  verification_expires_at?: Date | null;
}

// ============ subscriber_methods table ============
export interface SubscriberMethodRecord {
  id: number;
  subscriber_user_id: number;
  method_type: SubscriptionMethodType;
  method_value: string;
  status: SubscriptionStatus;
  meta: string | null; // JSON for extra config
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface SubscriberMethodRecordInsert {
  subscriber_user_id: number;
  method_type: SubscriptionMethodType;
  method_value: string;
  status?: SubscriptionStatus;
  meta?: string | null;
}

// ============ user_subscriptions_v2 table ============
export interface UserSubscriptionV2Record {
  id: number;
  subscriber_user_id: number;
  subscriber_method_id: number;
  event_type: SubscriptionEventType;

  status: SubscriptionStatus;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface UserSubscriptionV2RecordInsert {
  subscriber_user_id: number;
  subscriber_method_id: number;
  event_type: SubscriptionEventType;

  status?: SubscriptionStatus;
}

export interface UserSubscriptionV2Filter {
  subscriber_user_id?: number;
  subscriber_method_id?: number;
  event_type?: SubscriptionEventType;

  status?: SubscriptionStatus;
}

// ============ Old types (kept for compatibility) ============

export interface UserSubscriptionRecord {
  id: number;
  subscriber_id: number;
  subscription_method: SubscriptionMethodType;
  event_type: SubscriptionEventType;

  status: SubscriptionStatus;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface UserSubscriptionRecordInsert {
  subscriber_id: number;
  subscription_method: SubscriptionMethodType;
  event_type: SubscriptionEventType;

  status?: SubscriptionStatus;
}

export interface UserSubscriptionFilter {
  subscriber_id?: number;
  subscription_method?: SubscriptionMethodType;
  event_type?: SubscriptionEventType;

  status?: SubscriptionStatus;
}

// Aggregated view for admin
export interface SubscriberSummary {
  id: number;
  subscriber_send: string;
  subscriber_type: string;
  subscriber_status: string;
  created_at: DbTimestamp;
  subscription_count: number;
  event_types: SubscriptionEventType[];
}

// Template JSON types for each template type
export interface EmailTemplateJson {
  email_subject: string;
  email_body: string; // HTML string
}

export interface WebhookTemplateJson {
  webhook_body: string; // JSON string
}

export interface SlackTemplateJson {
  slack_body: string; // JSON string
}

export interface DiscordTemplateJson {
  discord_body: string; // JSON string
}

export interface TriggerHeader {
  key: string;
  value: string;
}
export interface TriggerMeta extends EmailTemplateJson, WebhookTemplateJson, SlackTemplateJson, DiscordTemplateJson {
  url: string;
  headers: TriggerHeader[];
  to: string;
  from: string;
}

export interface SubscriptionsConfig {
  enable: boolean;
  methods: {
    emails: {
      incidents: boolean;
      maintenances: boolean;
    };
  };
}

// ============ Audit log ============

export type AuditActorType = "user" | "api_key" | "system" | "oidc" | "anonymous";
export type AuditOutcome = "ok" | "denied" | "error";

export interface AuditLogInsert {
  org_id?: number | null;
  ts: number;
  request_id?: string | null;
  actor_type: AuditActorType;
  actor_id?: string | null;
  actor_label?: string | null;
  action: string;
  permission?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  outcome: AuditOutcome;
  status_code?: number | null;
  ip?: string | null;
  user_agent?: string | null;
  before_json?: string | null;
  after_json?: string | null;
  meta_json?: string | null;
}

export interface AuditLogRecord extends AuditLogInsert {
  id: number;
}

export interface AuditLogFilter {
  org_id?: number | null;
  action?: string;
  actor_type?: AuditActorType;
  actor_id?: string;
  outcome?: AuditOutcome;
  start?: number;
  end?: number;
}

// ---------------------------------------------------------------- MFA

export interface MfaTotpRecord {
  user_id: number;
  /** A `secretBox` envelope over the base32 TOTP secret. Never the secret. */
  secret_enc: string;
  confirmed_at: number | null;
  last_used_step: number | null;
  created_at: number;
  updated_at: number;
}

export interface MfaRecoveryCodeRecord {
  id: number;
  user_id: number;
  code_hash: string;
  used_at: number | null;
  created_at: number;
}

/** Who has to present a second factor. Stored in `site_data.mfaPolicy`. */
export type MfaPolicy = "none" | "local_only" | "all";

// ---------------------------------------------------------------- sessions

/** How strongly the user authenticated. Written by A2; `none` until then. */
export type SessionMfaLevel = "none" | "totp" | "recovery" | "idp";

export interface SessionInsert {
  id: string;
  user_id: number;
  active_org_id?: number | null;
  issued_at: number;
  last_seen_at: number;
  expires_at: number;
  epoch: number;
  mfa_level?: string;
  ip?: string | null;
  user_agent?: string | null;
}

export interface SessionRecord {
  id: string;
  user_id: number;
  active_org_id: number | null;
  issued_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_reason: string | null;
  epoch: number;
  mfa_level: string;
  ip: string | null;
  user_agent: string | null;
}

// ---------------------------------------------------------------- webhooks

export type WebhookEndpointStatus = "ACTIVE" | "DISABLED" | "DISABLED_AUTO";

export interface WebhookEndpointRecord {
  id: number;
  org_id: number;
  name: string;
  url: string;
  secret_encrypted: string;
  secret_hint: string | null;
  previous_secret_encrypted: string | null;
  previous_secret_expires_at: number | null;
  status: WebhookEndpointStatus;
  api_version: string;
  custom_headers: string | null;
  timeout_ms: number;
  consecutive_failures: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  created_at: number;
  updated_at: number;
}

/** An endpoint plus the event types it subscribes to. */
export interface WebhookEndpointWithEvents extends WebhookEndpointRecord {
  event_types: string[];
}

export interface WebhookEndpointInsert {
  org_id: number;
  name: string;
  url: string;
  secret_encrypted: string;
  secret_hint: string | null;
  status: WebhookEndpointStatus;
  api_version: string;
  custom_headers: string | null;
  timeout_ms: number;
  created_at: number;
  updated_at: number;
}
