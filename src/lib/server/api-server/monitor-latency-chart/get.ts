import { json, error } from "@sveltejs/kit";
import type { APIServerRequest } from "$lib/server/types/api-server";
import db from "$lib/server/db/db";
import { ResolveVisiblePublicMonitor } from "$lib/server/controllers/publicMonitorResolver";
import { GetMinuteStartNowTimestampUTC } from "$lib/server/tool";
import { readLatencySeries, snapToGrain } from "$lib/server/services/latencyPercentiles";
import { MERGED_REGION_ID } from "$lib/server/db/regions";

/**
 * Time range definitions with aggregation intervals
 * Designed to keep data points under 100 for performance
 */
interface TimeRange {
  label: string;
  value: string;
  minutes: number; // Total minutes in the range
  avgInterval: number; // Minutes to average together
}

const TIME_RANGES: TimeRange[] = [
  { label: "Last Hour", value: "1h", minutes: 60, avgInterval: 1 }, // 60 points
  { label: "Last 3 Hours", value: "3h", minutes: 180, avgInterval: 5 }, // 36 points
  { label: "Last 6 Hours", value: "6h", minutes: 360, avgInterval: 10 }, // 36 points
  { label: "Last 12 Hours", value: "12h", minutes: 720, avgInterval: 15 }, // 48 points
  { label: "Last 24 Hours", value: "24h", minutes: 1440, avgInterval: 30 }, // 48 points
  { label: "Last 48 Hours", value: "48h", minutes: 2880, avgInterval: 60 }, // 48 points
  { label: "Last 7 Days", value: "7d", minutes: 10080, avgInterval: 180 }, // 56 points (3-hour avg)
  { label: "Last 14 Days", value: "14d", minutes: 20160, avgInterval: 360 }, // 56 points (6-hour avg)
  { label: "Last 30 Days", value: "30d", minutes: 43200, avgInterval: 720 }, // 60 points (12-hour avg)
];

/**
 * GET /dashboard-apis/monitor-latency-chart?tag=xxx&range=24h&localTz=xxx
 * Returns aggregated latency data for chart visualization
 */
export default async function get(req: APIServerRequest): Promise<Response> {
  const tag = req.query.get("tag");
  const range = req.query.get("range") || "24h";
  const localTz = req.query.get("localTz") || "UTC";

  if (!tag) {
    return error(400, { message: "tag query parameter is required" });
  }

  // Visible, not merely existing. See publicMonitorResolver (KENER-126).
  const monitor = await ResolveVisiblePublicMonitor(tag);
  if (!monitor) {
    return error(404, { message: "Monitor not found" });
  }

  // Find the time range config
  const rangeConfig = TIME_RANGES.find((r) => r.value === range);
  if (!rangeConfig) {
    return error(400, { message: "Invalid range parameter" });
  }

  const now = GetMinuteStartNowTimestampUTC();
  const intervalSeconds = rangeConfig.avgInterval * 60;

  // Snapped onto the rollup grid (B4). The range used to be `now - N minutes`,
  // whose edges land wherever the current minute happens to be and so almost
  // never on a 5m or 1h boundary - and `pickGrain` refuses an unaligned request,
  // because a rollup bucket straddling two output buckets cannot be attributed
  // to either. Every range therefore fell through to raw samples, which is how
  // the 30-day chart came to pull 43,200 rows and bucket them in a nested
  // `filter()` loop.
  //
  // Snapping moves an edge by less than one grain, and has a second effect worth
  // having anyway: the buckets stop sliding every minute, so the chart is stable
  // between refreshes instead of redrawing itself with every point shifted.
  const points = Math.max(1, Math.ceil(rangeConfig.minutes / rangeConfig.avgInterval));
  const startTimestamp = snapToGrain(now - rangeConfig.minutes * 60, intervalSeconds);

  const regionParam = req.query.get("region");
  const regionId = regionParam !== null && regionParam !== "" ? Number(regionParam) : MERGED_REGION_ID;
  if (!Number.isFinite(regionId) || regionId < 0) {
    return error(400, { message: "region must be a non-negative integer" });
  }

  const series = await readLatencySeries({
    monitorTag: monitor.tag,
    regionId,
    startTimestamp,
    intervalSeconds,
    points,
  });

  const round = (value: number | null) => (value === null ? null : Math.round(value));

  const aggregatedData = series.points.map((point) => ({
    // The middle of the bucket, as before, so the existing chart plots unchanged.
    timestamp: point.ts + Math.floor(intervalSeconds / 2),
    avgLatency: round(point.avg),
    minLatency: round(point.min),
    maxLatency: round(point.max),
    // B4. Null where the bucket has no samples, exactly like the three above.
    p50: round(point.p50),
    p90: round(point.p90),
    p95: round(point.p95),
    p99: round(point.p99),
  }));

  return json({
    data: aggregatedData,
    range: rangeConfig.value,
    rangeLabel: rangeConfig.label,
    avgInterval: rangeConfig.avgInterval,
    periodStart: startTimestamp,
    periodEnd: startTimestamp + points * intervalSeconds,
    // The whole window as one figure, merged from the histograms rather than
    // averaged across the points above - percentiles do not average.
    rangePercentiles: {
      p50: round(series.range.p50),
      p90: round(series.range.p90),
      p95: round(series.range.p95),
      p99: round(series.range.p99),
      avg: round(series.range.avg),
      min: round(series.range.min),
      max: round(series.range.max),
      count: series.range.count,
    },
    // Which grain answered, and which regions have data. Both are here so an
    // operator debugging a number can see where it came from without guessing.
    source: series.source,
    regions: series.regions,
    regionId,
  });
}
