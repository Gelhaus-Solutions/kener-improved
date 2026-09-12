// Server-only monitor types (internal representation with all fields).

import type { PingHost, PingMonitorTypeData } from "$lib/types/ping.js";
import type { TcpHost, TcpMonitorTypeData } from "$lib/types/tcp.js";
import type { DockerMonitorTypeData } from "$lib/types/docker.js";

export interface MonitoringResult {
  status: string;
  latency: number;
  type: string;
  error_message?: string;
  raw_status?: string;
}

export interface MonitoringResultTS {
  [timestamp: number]: MonitoringResult;
}

export interface NoneMonitorTypeData {
  overrideWithLastKnownStatus: boolean;
}
export interface ApiMonitorTypeData {
  url: string;
  body?: string;
  headers?: Array<{ key: string; value: string }>;
  method: string;
  timeout?: number;
  eval?: string;
  allowSelfSignedCert?: boolean;
  follow_redirects?: boolean;
  max_redirects?: number;
  proxy?: string; // http(s):// proxy URL; `$SECRET` substitution applies; empty = process env proxy
  /**
   * I6. Send resolved `$SECRET` values over an unencrypted URL anyway.
   *
   * Off by default, so a credential is never put on the wire in clear text
   * unless somebody said so. Ticked by the migration on monitors that were
   * already doing it, so an upgrade breaks nothing that worked yesterday.
   */
  allowPlaintextSecrets?: boolean;
}

export interface DnsMonitorTypeData {
  nameServer: string;
  host: string;
  lookupRecord: string;
  matchType: "ALL" | "ANY";
  values: string[];
  transport?: "UDP" | "TLS";
  tlsPort?: number;
  tlsServername?: string;
  allowSelfSignedCert?: boolean;
}

export type { PingHost, PingMonitorTypeData };
export type { TcpHost, TcpMonitorTypeData };

export interface SslMonitorTypeData {
  host: string;
  port?: string;
  degradedRemainingHours: number;
  downRemainingHours: number;
}

export interface SqlMonitorTypeData {
  dbType: string;
  connectionString: string;
  query: string;
  timeout?: number;
}

export interface HeartbeatMonitorTypeData {
  downRemainingMinutes: number;
  degradedRemainingMinutes: number;
  secretString: string;
  /**
   * B11. The schedule the job is expected to keep, as a cron pattern. Empty or
   * absent keeps the original interval behaviour, so existing monitors are
   * untouched until someone opts in.
   */
  expectedCron?: string;
  /** B11. IANA zone the cron is read in. Absent means UTC. */
  cronTimezone?: string;
  /** B11. Minutes past the expected time before a run counts as late. */
  graceMinutes?: number;
}

export interface GroupMonitorMember {
  tag: string;
  /** Weight for this monitor. All weights in a group must sum to 1. */
  weight: number;
}

export interface GroupMonitorTypeData extends Record<string, unknown> {
  monitors: GroupMonitorMember[];
  executionDelay: number;
  latencyCalculation: "AVG" | "MAX" | "MIN";
}

export interface GamedigMonitorTypeData {
  gameId: string;
  host: string;
  port: number;
  timeout?: number;
  eval?: string;
  guessPort?: boolean;
  requestRules?: boolean;
}

export interface GrpcMonitorTypeData {
  host: string;
  port: number;
  service?: string;
  tls?: boolean;
  insecure?: boolean;
  timeout?: number;
}

export interface PrometheusThreshold {
  operator: ">" | ">=" | "<" | "<=" | "==" | "!=";
  value: number;
}

export interface PrometheusMonitorTypeData {
  url: string; // Prometheus base URL, e.g. https://prom.example.com or https://host/prom
  query: string; // PromQL instant query
  down?: PrometheusThreshold; // matches when `metricValue <operator> value` -> DOWN
  degraded?: PrometheusThreshold; // matches when `metricValue <operator> value` -> DEGRADED
  noDataStatus?: "UP" | "DEGRADED" | "DOWN"; // empty-result status, default "DOWN"
  // Status for "Prometheus did not answer": transport failure, timeout, non-2xx, or a
  // malformed/non-success payload. Default "DOWN". Distinct from noDataStatus, which covers a
  // successful query that matched nothing — a lost scrape and an empty result mean different
  // things, and a monitor charting a capacity metric usually wants the former to read DEGRADED
  // rather than announce a false outage.
  errorStatus?: "UP" | "DEGRADED" | "DOWN";
  headers?: { key: string; value: string }[]; // optional; secret substitution applies
  timeout?: number; // ms, default 10000
  allowSelfSignedCert?: boolean; // default false
  /**
   * I6. Send resolved `$SECRET` values over an unencrypted URL anyway.
   *
   * Off by default, so a credential is never put on the wire in clear text
   * unless somebody said so. Ticked by the migration on monitors that were
   * already doing it, so an upgrade breaks nothing that worked yesterday.
   */
  allowPlaintextSecrets?: boolean;
  proxy?: string; // as ApiMonitorTypeData.proxy
}

export type MonitorTypeData =
  | ApiMonitorTypeData
  | DnsMonitorTypeData
  | PingMonitorTypeData
  | TcpMonitorTypeData
  | SslMonitorTypeData
  | SqlMonitorTypeData
  | HeartbeatMonitorTypeData
  | GroupMonitorTypeData
  | GamedigMonitorTypeData
  | GrpcMonitorTypeData
  | PrometheusMonitorTypeData
  | DockerMonitorTypeData;

export interface Monitor<T = MonitorTypeData> {
  tag: string;
  type_data: T;
  cron?: string;
}

export type NoneMonitor = Monitor<NoneMonitorTypeData>;
export type ApiMonitor = Monitor<ApiMonitorTypeData>;
export type DnsMonitor = Monitor<DnsMonitorTypeData>;
export type PingMonitor = Monitor<PingMonitorTypeData>;
export type TcpMonitor = Monitor<TcpMonitorTypeData>;
export type SslMonitor = Monitor<SslMonitorTypeData>;
export type SqlMonitor = Monitor<SqlMonitorTypeData>;
export type HeartbeatMonitor = Monitor<HeartbeatMonitorTypeData>;
export type GroupMonitor = Monitor<GroupMonitorTypeData>;
export type GamedigMonitor = Monitor<GamedigMonitorTypeData>;
export type GrpcMonitor = Monitor<GrpcMonitorTypeData>;
export type PrometheusMonitor = Monitor<PrometheusMonitorTypeData>;
export type DockerMonitor = Monitor<DockerMonitorTypeData>;

export interface EvalResponse {
  status?: string;
  latency?: number;
  type?: string;
}
