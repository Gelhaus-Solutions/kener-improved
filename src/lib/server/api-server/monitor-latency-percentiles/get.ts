import { json, error } from "@sveltejs/kit";
import type { APIServerRequest } from "$lib/server/types/api-server";
import { ResolveVisiblePublicMonitor } from "$lib/server/controllers/publicMonitorResolver";
import { GetMinuteStartNowTimestampUTC } from "$lib/server/tool";
import { readLatencySeries, snapToGrain, type LatencyPoint } from "$lib/server/services/latencyPercentiles";
import { MERGED_REGION_ID } from "$lib/server/db/regions";
import { ROLLUP_GRAIN_SECONDS, type RollupGrain } from "$lib/server/types/db";

/**
 * GET /dashboard-apis/monitor-latency-percentiles?tag=&grain=&points=&region=
 *
 * p50/p90/p95/p99 per bucket, plus the range as one figure (B4).
 *
 * **Separate from `monitor-latency-chart`, which now returns percentiles too.**
 * That one answers "draw me this named range at the interval I picked for it";
 * this one answers "give me percentiles at a grain I name", which is what a
 * report (F1, F3) needs and what the public API is a thin wrapper over. Keeping
 * them apart means the chart's `TIME_RANGES` table is not quietly the definition
 * of what any other consumer can ask for.
 *
 * Asking for a grain directly is also what makes the cheap path reachable: one
 * output point per rollup bucket means the materialized columns are read
 * verbatim and no histogram JSON is parsed at all.
 */
const GRAINS: RollupGrain[] = ["5m", "1h", "1d"];
const MAX_POINTS = 1000;

export default async function get(req: APIServerRequest): Promise<Response> {
  const tag = req.query.get("tag");
  if (!tag) return error(400, { message: "tag query parameter is required" });

  const monitor = await ResolveVisiblePublicMonitor(tag);
  if (!monitor) return error(404, { message: "Monitor not found" });

  const grainParam = (req.query.get("grain") ?? "1h") as RollupGrain;
  if (!GRAINS.includes(grainParam)) {
    return error(400, { message: `grain must be one of ${GRAINS.join(", ")}` });
  }

  const pointsParam = Number(req.query.get("points") ?? "24");
  if (!Number.isFinite(pointsParam) || pointsParam < 1 || pointsParam > MAX_POINTS) {
    return error(400, { message: `points must be between 1 and ${MAX_POINTS}` });
  }
  const points = Math.floor(pointsParam);

  const regionParam = req.query.get("region");
  const regionId = regionParam !== null && regionParam !== "" ? Number(regionParam) : MERGED_REGION_ID;
  if (!Number.isFinite(regionId) || regionId < 0) {
    return error(400, { message: "region must be a non-negative integer" });
  }

  const intervalSeconds = ROLLUP_GRAIN_SECONDS[grainParam];
  const now = GetMinuteStartNowTimestampUTC();

  // `to` names the end of the window and the caller gets `points` buckets ending
  // there.
  //
  // **An explicit `to` is taken literally and never snapped**, because the
  // caller that has one is the status page, whose day boundaries are the
  // *viewer's* - and IANA offsets include :30 and :45. Kolkata's day starts
  // 19,800 seconds past a UTC day, so snapping a daily request onto the UTC grid
  // would quietly hand that viewer somebody else's days, off by five and a half
  // hours at every edge. Unsnapped, `readLatencySeries` picks a grain that
  // divides the offset instead: 300 divides every IANA offset, so a half-hour
  // viewer reads five-minute buckets and merges them, which is correct.
  //
  // Without an explicit `to` there is no alignment to preserve, and snapping is
  // what puts one output point on exactly one rollup bucket - the case where the
  // materialized percentile columns are read verbatim and no JSON is parsed.
  const toParam = req.query.get("to");
  const explicitTo = toParam !== null && toParam !== "" && Number.isFinite(Number(toParam));
  const to = explicitTo ? Number(toParam) : now;
  const startTimestamp = explicitTo
    ? to - points * intervalSeconds
    : snapToGrain(to - points * intervalSeconds, intervalSeconds);

  const series = await readLatencySeries({
    monitorTag: monitor.tag,
    regionId,
    startTimestamp,
    intervalSeconds,
    points,
  });

  return json({
    tag,
    grain: grainParam,
    regionId,
    regions: series.regions,
    source: series.source,
    periodStart: startTimestamp,
    periodEnd: startTimestamp + points * intervalSeconds,
    points: series.points.map(shape),
    range: shape(series.range),
  });
}

/** Rounded to whole milliseconds, which is the precision a latency figure has. */
function shape(point: LatencyPoint) {
  const round = (value: number | null) => (value === null ? null : Math.round(value));
  return {
    ts: point.ts,
    count: point.count,
    avg: round(point.avg),
    min: round(point.min),
    max: round(point.max),
    p50: round(point.p50),
    p90: round(point.p90),
    p95: round(point.p95),
    p99: round(point.p99),
  };
}
