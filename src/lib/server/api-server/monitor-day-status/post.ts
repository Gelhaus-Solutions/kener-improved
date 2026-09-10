import { json, error } from "@sveltejs/kit";
import type { APIServerRequest } from "$lib/server/types/api-server";
import db from "$lib/server/db/db";
import {
  BeginningOfDay,
  GetMinuteStartNowTimestampUTC,
  GetMinuteStartTimestampUTC,
  ParseUptime,
  UptimeCalculator,
} from "$lib/server/tool";
import GC from "$lib/global-constants";
import { ResolveVisiblePublicMonitor } from "../../controllers/publicMonitorResolver.js";
import { parseMonitorSettings } from "../monitor-bar/shared";
import type { TimestampStatusCount } from "$lib/server/types/db";

interface DayDetailRequest {
  tag: string;
}

interface MinuteData {
  timestamp: number;
  status: string;
}

/**
 * POST /dashboard-apis/monitor-uptime
 * Returns minute-by-minute data for a specific day
 */
export default async function post(req: APIServerRequest): Promise<Response> {
  const body = req.body as DayDetailRequest;

  if (!body.tag) {
    return error(400, { message: "tag is required" });
  }

  const startOfDayTodayAtTz = req.body.startOfDayTodayAtTz
    ? parseInt(req.body.startOfDayTodayAtTz || "0", 10)
    : BeginningOfDay();

  const nowAtTz =
    GetMinuteStartTimestampUTC(
      req.body.nowAtTz ? parseInt(req.body.nowAtTz || "0", 10) : GetMinuteStartNowTimestampUTC(),
    ) + 60;

  // Visible, not merely existing (KENER-126).
  const monitor = await ResolveVisiblePublicMonitor(body.tag);
  if (!monitor) {
    return error(404, { message: "Monitor not found" });
  }
  // Unlike its three siblings this endpoint needs the uptime formula, and the
  // resolver returns the raw row. Parsed with the helper the bar builder already
  // uses, rather than by re-reading the monitor through a second query.
  const monitorSettings = parseMonitorSettings(monitor.monitor_settings_json);

  // Get raw monitoring data for the day
  const rawData = await db.getMonitoringData(monitor.tag, startOfDayTodayAtTz, nowAtTz);
  const minuteData: MinuteData[] = [];
  let upCount = 0;
  let downCount = 0;
  let degradedCount = 0;
  let maintenanceCount = 0;

  // Create a map for quick lookup
  const dataMap = new Map<number, string>();
  for (const d of rawData) {
    dataMap.set(d.timestamp, d.status || GC.NO_DATA);
  }

  for (let i = startOfDayTodayAtTz; i < nowAtTz; i += 60) {
    const status = dataMap.get(i) || GC.NO_DATA;

    minuteData.push({
      timestamp: i,
      status: status,
    });

    if (status === GC.UP) upCount++;
    else if (status === GC.DOWN) downCount++;
    else if (status === GC.DEGRADED) degradedCount++;
    else if (status === GC.MAINTENANCE) maintenanceCount++;
  }

  const item: TimestampStatusCount = {
    ts: nowAtTz - 60,
    countOfUp: upCount,
    countOfDown: downCount,
    countOfDegraded: degradedCount,
    countOfMaintenance: maintenanceCount,
    avgLatency: 0,
    maxLatency: 0,
    minLatency: 0,
  };

  const uptimeCalculationResult = UptimeCalculator(
    [item],
    monitorSettings.uptime_formula_numerator,
    monitorSettings.uptime_formula_denominator,
  );

  return json({
    minutes: minuteData,
    uptime: uptimeCalculationResult.uptime,
  });
}
