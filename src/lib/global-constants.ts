import type { MonitoringStatus } from "$lib/types/status.js";

// Badge styles supported by badge-maker
export const BADGE_STYLES = ["flat", "plastic", "flat-square", "for-the-badge", "social"] as const;
export type BadgeStyle = (typeof BADGE_STYLES)[number];

// Status types
export const MONITORING_STATUSES = ["UP", "DOWN", "DEGRADED"] as const satisfies readonly MonitoringStatus[];

export function isMonitoringStatus(value: unknown): value is MonitoringStatus {
  return typeof value === "string" && MONITORING_STATUSES.includes(value as MonitoringStatus);
}

// Incident states
export type IncidentState = "INVESTIGATING" | "IDENTIFIED" | "MONITORING" | "RESOLVED";

// Page status messages for overall system status
export const PAGE_STATUS_MESSAGES = {
  UNDER_MAINTENANCE: "Under Maintenance",
  ALL_OPERATIONAL: "All Systems Operational",
  DEGRADED_PERFORMANCE: "Degraded Performance",
  PARTIAL_DEGRADED: "Partial Degraded Performance",
  PARTIAL_OUTAGE: "Partial System Outage",
  MAJOR_OUTAGE: "Major System Outage",
  NO_DATA: "No Status Available",
} as const;

// Helper to validate and get badge style
export function getBadgeStyle(style: string | null): BadgeStyle {
  if (style && BADGE_STYLES.includes(style as BadgeStyle)) {
    return style as BadgeStyle;
  }
  return "flat";
}

export default {
  UP: "UP",
  DOWN: "DOWN",
  DEGRADED: "DEGRADED",
  INCIDENT: "INCIDENT",
  MAINTENANCE: "MAINTENANCE",
  NO_DATA: "NO_DATA",
  ALERT: "ALERT",
  REALTIME: "REALTIME",
  TIMEOUT: "TIMEOUT",
  ERROR: "ERROR",
  MANUAL: "MANUAL",
  // An operator hand-rewriting history from the admin screen (KENER-123).
  // Split out of MANUAL, which meant both this and "an external system pushed a
  // measurement" - two things with opposite provenance and opposite claims about
  // whether their latency is real. See docs/adr/0005.
  OPERATOR: "OPERATOR",
  WEBHOOK: "WEBHOOK",
  DEFAULT_STATUS: "DEFAULT",
  SIGNAL: "SIGNAL",
  INVITE_VERIFY_EMAIL: "invite_verify_email",
  ERROR_NO_SETUP: "Set up not done yet. Create a user first.",
  INVESTIGATING: "INVESTIGATING",
  IDENTIFIED: "IDENTIFIED",
  MONITORING: "MONITORING",
  RESOLVED: "RESOLVED",
  YES: "YES",
  NO: "NO",
  TRIGGERED: "TRIGGERED",
  CRITICAL: "CRITICAL",
  CLOSED: "CLOSED",
  WARNING: "WARNING",
  defaultNumeratorStr: "up + maintenance + degraded",
  defaultDenominatorStr: "up + down + degraded + maintenance",
  DEFAULT_UP_COLOR: "#28a745",
  DEFAULT_DOWN_COLOR: "#dc3545",
  DEFAULT_DEGRADED_COLOR: "#ffc107",
  DEFAULT_MAINTENANCE_COLOR: "#17a2b8",
  ONGOING: "ONGOING",
  SCHEDULED: "SCHEDULED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  READY: "READY",
  ACTIVE: "ACTIVE",
  STATUS: "STATUS",
  LATENCY: "LATENCY",
  UPTIME: "UPTIME",
  // F1b. An alert on an SLO target's burn rate, not on a monitor.
  SLO_BURN_RATE: "SLO_BURN_RATE",
  // Special path segment addressing the home page in the v4 API; its stored
  // page_path is an empty string. See docs/adr/0004-home-page-api-token.md.
  HOME_PAGE_TOKEN: "~home",
  // Status history window (days of per-day status shown), shared by pages and
  // monitors, the manage UI, the public pages, and the v4 API
  DEFAULT_STATUS_HISTORY_DAYS_DESKTOP: 90,
  DEFAULT_STATUS_HISTORY_DAYS_MOBILE: 30,
  STATUS_HISTORY_DAYS_MIN: 1,
  STATUS_HISTORY_DAYS_MAX: 365,
  // Monitor layout styles available on status pages
  MONITOR_LAYOUT_STYLES: ["default-list", "default-grid", "compact-list", "compact-grid"],
  DEFAULT_MONITOR_LAYOUT_STYLE: "default-list",
  DOCS_URL: "https://kener.ing/docs",
  MAX_UPLOAD_BYTES: 2 * 1024 * 1024, // 2MB
  MAX_IMAGE_DIMENSION: 4096,
  MAX_INPUT_PIXELS: 4096 * 4096,
  AUTH_PROVIDER_LOCAL: "local",
  AUTH_PROVIDER_OIDC: "oidc",
  // B1b. The monitor types a remote probe can run, which is a much shorter list
  // than the types that exist.
  //
  // The test is whether a check needs anything of Kener's but the monitor row:
  //
  //   GROUP       reads Redis for its members' cached statuses
  //   HEARTBEAT   reads the database for the last receipt
  //   SQL         needs a database connection Kener holds
  //   PROMETHEUS  and DOCKER need server-side reachability and credentials
  //   NONE        computes nothing
  //   GAMEDIG     and GRPC are omitted for now because neither has been run
  //               outside the server process; they are candidates, not
  //               exclusions on principle.
  //
  // The five that remain take `(monitor, timestamp)`, open one socket and touch
  // no database, which is exactly what makes them safe to run somewhere else.
  // An agent's reported `capabilities` are intersected with this rather than
  // trusted, so an agent cannot be handed a check this list forbids.
  PROBE_ELIGIBLE_TYPES: ["API", "PING", "TCP", "DNS", "SSL"],
} as const;
