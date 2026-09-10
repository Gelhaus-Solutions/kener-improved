import db from "$lib/server/db/db";
import { readLatencySeries } from "../../services/latencyPercentiles.js";
import GC from "$lib/global-constants";
import type { StatusType } from "$lib/types/status";
import type { MonitorRecord, TimestampStatusCount } from "$lib/server/types/db";
import { UptimeCalculator } from "$lib/server/tool";
import { GetStatusCountsByInterval } from "$lib/server/controllers/monitorsController";
import type { MonitorBarResponse } from "./get";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { startOfDay, getUnixTime } from "date-fns";

/**
 * End of today in `timeZone`, as UTC seconds. This is the bar's right-hand edge,
 * and it decides where every day bucket falls.
 *
 * The browser computes the same value from the viewer's timezone in
 * `$lib/client/layoutClientData`. Kept identical on purpose: a server render and
 * a client render of the same bar must agree, or the bars shift by a day.
 * IANA offsets include :30 and :45, so this cannot be integer arithmetic on a
 * UTC day.
 */
export const endOfDayAtTz = (timeZone: string): number => {
  const now = new Date();
  const startOfDayInUTC = fromZonedTime(startOfDay(toZonedTime(now, timeZone)), timeZone);
  return getUnixTime(startOfDayInUTC) + 86400;
};

interface ParsedMonitorSettings {
  uptime_formula_numerator?: string;
  uptime_formula_denominator?: string;
}

export const parseMonitorSettings = (value: string | null): ParsedMonitorSettings => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as ParsedMonitorSettings;
    return parsed || {};
  } catch {
    return {};
  }
};

const fillMissingUptimeData = (
  rawUptimeData: TimestampStatusCount[],
  startTime: number,
  days: number,
): TimestampStatusCount[] => {
  const uptimeData: TimestampStatusCount[] = [];
  const uptimeDataMap = new Map(rawUptimeData.map((d) => [d.ts, d]));

  for (let i = 0; i < days; i++) {
    const ts = startTime + i * 86400;
    const data = uptimeDataMap.get(ts);
    if (data) {
      uptimeData.push(data);
    } else {
      uptimeData.push({
        ts,
        countOfUp: 0,
        countOfDown: 0,
        countOfDegraded: 0,
        countOfMaintenance: 0,
        avgLatency: 0,
        maxLatency: 0,
        minLatency: 0,
      });
    }
  }

  return uptimeData;
};

export const buildMonitorBarResponse = async (
  monitor: MonitorRecord,
  days: number,
  endOfDayTodayAtTz: number,
  latestStatus?: StatusType,
): Promise<MonitorBarResponse> => {
  const startTime = endOfDayTodayAtTz - days * 24 * 60 * 60;
  // Through the controller rather than straight to the repository (I9): that is
  // where the rollup read path, its cache and the raw-SQL fallback live, and a
  // second call site reaching past it would quietly keep scanning 129,600 rows
  // per monitor while the other one did not.
  const [rawUptimeData, latestData] = await Promise.all([
    GetStatusCountsByInterval(monitor.tag, startTime, 86400, days),
    latestStatus ? Promise.resolve(null) : db.getLatestMonitoringData(monitor.tag),
  ]);

  const response = buildMonitorBarResponseFromRawData(
    monitor,
    rawUptimeData,
    days,
    endOfDayTodayAtTz,
    latestStatus || (latestData?.status as StatusType) || GC.NO_DATA,
  );

  // B4: the window's percentiles, merged from the histograms.
  //
  // **Only on this path, never in `buildMonitorBarResponseFromRawData`.** That
  // function is synchronous and is what the batch endpoint calls for up to a
  // hundred monitors at once; giving it a percentile read would turn one page
  // render into a hundred extra queries. This path serves a single monitor - the
  // embeds and the single-bar endpoint - where one more query is the right price
  // for a real number.
  //
  // A failure here costs the percentiles and not the bar: the uptime figures are
  // already computed above and a monitor whose rollups are not backfilled simply
  // has none to report.
  try {
    const series = await readLatencySeries({
      monitorTag: monitor.tag,
      startTimestamp: startTime,
      intervalSeconds: 86400,
      points: days,
    });
    const round = (value: number | null) => (value === null ? null : Math.round(value));
    if (series.range.count > 0) {
      response.latencyPercentiles = {
        p50: round(series.range.p50),
        p90: round(series.range.p90),
        p95: round(series.range.p95),
        p99: round(series.range.p99),
      };
    }
  } catch {
    // Left absent, which is what the optional field means.
  }

  return response;
};

export const buildMonitorBarResponseFromRawData = (
  monitor: MonitorRecord,
  rawUptimeData: TimestampStatusCount[],
  days: number,
  endOfDayTodayAtTz: number,
  latestStatus?: StatusType,
): MonitorBarResponse => {
  const startTime = endOfDayTodayAtTz - days * 24 * 60 * 60;
  const monitorSettings = parseMonitorSettings(monitor.monitor_settings_json);
  const uptimeCalculationResult = UptimeCalculator(
    rawUptimeData,
    monitorSettings.uptime_formula_numerator,
    monitorSettings.uptime_formula_denominator,
  );

  return {
    name: monitor.name,
    description: monitor.description || "",
    image: monitor.image || null,
    currentStatus: latestStatus || GC.NO_DATA,
    uptime: uptimeCalculationResult.uptime,
    uptimeData: fillMissingUptimeData(rawUptimeData, startTime, days),
    fromTimeStamp: startTime,
    toTimeStamp: endOfDayTodayAtTz - 1,
    avgLatency: uptimeCalculationResult.avgLatency,
    maxLatency: uptimeCalculationResult.maxLatency,
    minLatency: uptimeCalculationResult.minLatency,
  };
};
