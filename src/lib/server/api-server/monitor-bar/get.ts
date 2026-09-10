import { json, error } from "@sveltejs/kit";
import type { APIServerRequest } from "$lib/server/types/api-server";
import { ResolveVisiblePublicMonitor } from "$lib/server/controllers/publicMonitorResolver";
import { GetMinuteStartNowTimestampUTC } from "$lib/server/tool";
import type { StatusType } from "$lib/types/status";
import type { TimestampStatusCount } from "$lib/server/types/db";
import { buildMonitorBarResponse } from "./shared";

const DEFAULT_DAYS = 90;
const MAX_DAYS = 90;

export interface BarData {
  status: StatusType;
  timestamp: number;
}

/** p50/p90/p95/p99 in milliseconds, null where there were no samples (B4). */
export interface LatencyPercentileSet {
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
}

export interface MonitorBarResponse {
  name: string;
  description: string;
  image: string | null;
  currentStatus: StatusType;
  uptime: string;
  avgLatency: string;
  uptimeData: TimestampStatusCount[];
  fromTimeStamp: number;
  toTimeStamp: number;
  maxLatency: string;
  minLatency: string;
  /**
   * The whole window's percentiles, merged from the histograms (B4).
   *
   * **Optional, and absent rather than zeroed when unavailable.** Every existing
   * consumer of this shape predates B4 and must be unaffected, and a monitor
   * whose rollups have not been backfilled has no percentiles to report - which
   * is a different statement from "its p95 is 0".
   *
   * Range-level only. A per-day breakdown belongs to whoever is drawing a chart,
   * and `monitor-latency-percentiles` is the endpoint for that; putting 90 days
   * of four percentiles into every bar response would grow a payload that a
   * status page fetches for every monitor on the page.
   */
  latencyPercentiles?: LatencyPercentileSet;
}

/**
 * GET /dashboard-apis/monitor-bar?tag=xxx&days=90&endOfDayTodayAtTz=xxx
 * Returns monitor info, uptime data, and calculated uptime/avgLatency for the specified days
 */

export default async function get(req: APIServerRequest): Promise<Response> {
  const tag = req.query.get("tag");
  const daysStr = req.query.get("days");
  // const numberOfDaysReceived
  const days = Math.min(MAX_DAYS, Math.max(1, daysStr ? parseInt(daysStr, 10) : DEFAULT_DAYS));
  const endOfDayTodayAtTzStr = req.query.get("endOfDayTodayAtTz");
  const endOfDayTodayAtTz = endOfDayTodayAtTzStr ? parseInt(endOfDayTodayAtTzStr, 10) : GetMinuteStartNowTimestampUTC();
  if (!tag) {
    return error(400, { message: "tag query parameter is required" });
  }

  // Visible, not merely existing (KENER-126). This endpoint answered for any
  // monitor whose tag you knew, hidden and inactive included, and returned its
  // name, description, image and ninety days of history.
  const monitor = await ResolveVisiblePublicMonitor(tag);
  if (!monitor) {
    return error(404, { message: "Monitor not found" });
  }
  const response = await buildMonitorBarResponse(monitor, days, endOfDayTodayAtTz);

  return json(response);
}
