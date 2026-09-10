import { json, type RequestHandler } from "@sveltejs/kit";
import { readLatencySeries, snapToGrain } from "$lib/server/services/latencyPercentiles";
import { MERGED_REGION_ID } from "$lib/server/db/regions";
import { GetMinuteStartNowTimestampUTC } from "$lib/server/tool";
import { ROLLUP_GRAIN_SECONDS, type RollupGrain } from "$lib/server/types/db";

/**
 * GET /api/v5/monitors/{tag}/latency?percentile=&from=&to=&grain=&region=
 *
 * Latency percentiles for a monitor, from the rollups (B4).
 *
 * **`locals.monitor` is already resolved and already scoped.** `hooks.server.ts`
 * establishes the API key's org, resolves the URL segment as a per-org slug
 * within it, and 404s if it names nothing - so this handler never repeats any of
 * that, and cannot accidentally answer for another tenant's monitor. The route
 * still has to appear in `ROUTE_SCOPE_MAP` or it is denied: an unmapped route
 * resolves to `undefined`, which callers treat as a refusal rather than as
 * "no permission needed".
 *
 * Unlike the dashboard endpoints this one serves **hidden and inactive monitors
 * too**, and that is deliberate rather than an oversight of KENER-126: this is an
 * authenticated administrative API, and an operator holding `monitors.read`
 * asking about their own hidden monitor is entitled to an answer. The public
 * surfaces are the ones that must not.
 */
const GRAINS: RollupGrain[] = ["5m", "1h", "1d"];
const PERCENTILES = ["p50", "p90", "p95", "p99"] as const;
type Percentile = (typeof PERCENTILES)[number];
const MAX_POINTS = 5000;

export const GET: RequestHandler = async ({ url, locals }) => {
  const monitor = locals.monitor;
  if (!monitor) {
    return json({ error: { code: "NOT_FOUND", message: "Monitor not found" } }, { status: 404 });
  }

  const grain = (url.searchParams.get("grain") ?? "1h") as RollupGrain;
  if (!GRAINS.includes(grain)) {
    return json(
      { error: { code: "BAD_REQUEST", message: `grain must be one of ${GRAINS.join(", ")}` } },
      { status: 400 },
    );
  }

  const percentileParam = url.searchParams.get("percentile");
  if (percentileParam !== null && !PERCENTILES.includes(percentileParam as Percentile)) {
    return json(
      { error: { code: "BAD_REQUEST", message: `percentile must be one of ${PERCENTILES.join(", ")}` } },
      { status: 400 },
    );
  }

  const regionParam = url.searchParams.get("region");
  const regionId = regionParam ? Number(regionParam) : MERGED_REGION_ID;
  if (!Number.isFinite(regionId) || regionId < 0) {
    return json({ error: { code: "BAD_REQUEST", message: "region must be a non-negative integer" } }, { status: 400 });
  }

  const intervalSeconds = ROLLUP_GRAIN_SECONDS[grain];
  const now = GetMinuteStartNowTimestampUTC();
  const toParam = Number(url.searchParams.get("to"));
  const to = Number.isFinite(toParam) && toParam > 0 ? toParam : now;
  const fromParam = Number(url.searchParams.get("from"));
  const from = Number.isFinite(fromParam) && fromParam > 0 ? fromParam : to - 24 * intervalSeconds;

  if (from >= to) {
    return json({ error: { code: "BAD_REQUEST", message: "from must be before to" } }, { status: 400 });
  }

  const startTimestamp = snapToGrain(from, intervalSeconds);
  const points = Math.ceil((to - startTimestamp) / intervalSeconds);
  if (points > MAX_POINTS) {
    return json(
      {
        error: {
          code: "BAD_REQUEST",
          message: `That window is ${points} buckets at grain ${grain}; the maximum is ${MAX_POINTS}. Use a coarser grain or a shorter window.`,
        },
      },
      { status: 400 },
    );
  }

  const series = await readLatencySeries({
    monitorTag: monitor.tag,
    regionId,
    startTimestamp,
    intervalSeconds,
    points: Math.max(1, points),
  });

  const round = (value: number | null) => (value === null ? null : Math.round(value));
  // `percentile=` narrows each point to that one figure. Without it every
  // percentile is returned, because a caller charting one series and a caller
  // building a table want different shapes and neither should have to make two
  // requests.
  const shape = (point: (typeof series.points)[number]) =>
    percentileParam
      ? { ts: point.ts, count: point.count, value: round(point[percentileParam as Percentile]) }
      : {
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

  return json({
    monitor_tag: monitor.tag,
    grain,
    percentile: percentileParam ?? null,
    region_id: regionId,
    regions: series.regions,
    // Which grain actually answered. "raw" means the rollups could not serve the
    // window - not backfilled yet - and the numbers were computed from samples.
    source: series.source,
    from: startTimestamp,
    to: startTimestamp + points * intervalSeconds,
    points: series.points.map(shape),
    range: shape(series.range),
  });
};
