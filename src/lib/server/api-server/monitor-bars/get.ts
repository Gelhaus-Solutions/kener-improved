import { json, error } from "@sveltejs/kit";
import type { APIServerRequest } from "$lib/server/types/api-server";
import { ResolveVisiblePublicMonitors } from "$lib/server/controllers/publicMonitorResolver";
import { GetMinuteStartNowTimestampUTC } from "$lib/server/tool";
import type { StatusType } from "$lib/types/status";
import GC from "$lib/global-constants";
import type { MonitorBarResponse } from "$lib/server/api-server/monitor-bar/get";
import { buildMonitorBarResponseFromRawData } from "$lib/server/api-server/monitor-bar/shared";
import {
  GetLatestMonitoringDataAllActive,
  GetStatusCountsByIntervalGroupedByMonitor,
} from "$lib/server/controllers/monitorsController";
import type { TimestampStatusCount, TimestampStatusCountByMonitor } from "$lib/server/types/db";

const DEFAULT_DAYS = 90;
const MAX_DAYS = 90;
const MAX_TAGS = 100;

interface MonitorBarsResponse {
  data: Record<string, MonitorBarResponse>;
  missingTags: string[];
}

/**
 * GET /dashboard-apis/monitor-bars?tags=tag1,tag2&days=90&endOfDayTodayAtTz=xxx
 * Returns monitor-bar payloads for multiple tags in one request.
 */
export default async function get(req: APIServerRequest): Promise<Response> {
  const tagsStr = req.query.get("tags");
  const daysStr = req.query.get("days");
  const days = Math.min(MAX_DAYS, Math.max(1, daysStr ? parseInt(daysStr, 10) : DEFAULT_DAYS));
  const endOfDayTodayAtTzStr = req.query.get("endOfDayTodayAtTz");
  const endOfDayTodayAtTz = endOfDayTodayAtTzStr ? parseInt(endOfDayTodayAtTzStr, 10) : GetMinuteStartNowTimestampUTC();

  if (!tagsStr) {
    return error(400, { message: "tags query parameter is required" });
  }

  const tags = Array.from(
    new Set(
      tagsStr
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  );

  if (tags.length === 0) {
    return error(400, { message: "At least one tag is required" });
  }

  if (tags.length > MAX_TAGS) {
    return error(400, { message: `Maximum ${MAX_TAGS} tags are allowed` });
  }

  const startTime = endOfDayTodayAtTz - days * 24 * 60 * 60;

  // Resolve first, because everything below needs *physical* tags while the
  // caller may have asked with per-org slugs (KENER-127). The page hands the
  // browser `monitorTag`, which is the slug, and this endpoint used to match on
  // `tag` alone - so in an org with a `tag_prefix` every bar on the page came
  // back empty, reported as a missing tag.
  //
  // Visible monitors only (KENER-126). Anything the caller may not see simply
  // does not resolve, and falls through to `missingTags` exactly as a name that
  // never existed does, so the response cannot be used to tell the two apart.
  const resolved = await ResolveVisiblePublicMonitors(tags);
  const physicalTags = [...new Set([...resolved.values()].map((m) => m.tag))];

  const [latestDataAll, aggregatedData] = await Promise.all([
    GetLatestMonitoringDataAllActive(physicalTags),
    GetStatusCountsByIntervalGroupedByMonitor(physicalTags, startTime, 86400, days),
  ]);

  const latestStatusByTag = new Map<string, StatusType>(
    latestDataAll.map((d) => [d.monitor_tag, (d.status as StatusType) || GC.NO_DATA]),
  );

  // Keyed by the name the caller used, not by the physical tag, so a browser that
  // asked for "api" can find "api" in the answer.
  const missingTags = tags.filter((t) => !resolved.has(t));

  const aggregatedByTag = new Map<string, TimestampStatusCount[]>();
  for (const row of aggregatedData as TimestampStatusCountByMonitor[]) {
    const arr = aggregatedByTag.get(row.monitor_tag) || [];
    arr.push({
      ts: row.ts,
      countOfUp: row.countOfUp,
      countOfDown: row.countOfDown,
      countOfDegraded: row.countOfDegraded,
      countOfMaintenance: row.countOfMaintenance,
      avgLatency: row.avgLatency,
      maxLatency: row.maxLatency,
      minLatency: row.minLatency,
    });
    aggregatedByTag.set(row.monitor_tag, arr);
  }

  const responseData: Record<string, MonitorBarResponse> = {};
  const monitorResults = await Promise.all(
    tags.map(async (requested) => {
      const monitor = resolved.get(requested);
      if (!monitor) return null;
      // The data was fetched under the physical tag; the answer is filed under
      // the name that was asked for.
      const payload = buildMonitorBarResponseFromRawData(
        monitor,
        aggregatedByTag.get(monitor.tag) || [],
        days,
        endOfDayTodayAtTz,
        latestStatusByTag.get(monitor.tag) || GC.NO_DATA,
      );
      return { tag: requested, payload };
    }),
  );

  for (const result of monitorResults) {
    if (result) {
      responseData[result.tag] = result.payload;
    }
  }

  const response: MonitorBarsResponse = {
    data: responseData,
    missingTags,
  };

  return json(response);
}
