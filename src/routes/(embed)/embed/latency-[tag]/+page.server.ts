import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import db from "$lib/server/db/db";
import { buildMonitorBarResponse, endOfDayAtTz } from "$lib/server/api-server/monitor-bar/shared";

const DEFAULT_DAYS = 90;
const MAX_DAYS = 90;
const DEFAULT_HEIGHT = 128;

export const load: PageServerLoad = async ({ params, url }) => {
  const { tag } = params;
  const theme = url.searchParams.get("theme");
  const daysParam = url.searchParams.get("days");
  const heightParam = url.searchParams.get("height");
  const metric = url.searchParams.get("metric") || "average"; // default to average if not provided
  const days = Math.min(MAX_DAYS, Math.max(1, daysParam ? parseInt(daysParam, 10) : DEFAULT_DAYS));
  const height = Math.max(50, heightParam ? parseInt(heightParam, 10) : DEFAULT_HEIGHT);

  // See the monitor-[tag] load: the server cannot know the viewer's timezone, so
  // it renders UTC unless ?tz= pins one, and the page refetches only on a real
  // day-boundary mismatch.
  const timeZone = url.searchParams.get("tz") || "UTC";
  let serverEndOfDayTodayAtTz: number;
  try {
    serverEndOfDayTodayAtTz = endOfDayAtTz(timeZone);
  } catch {
    serverEndOfDayTodayAtTz = endOfDayAtTz("UTC");
  }

  const monitor = await db.getMonitorByTag(tag);
  if (!monitor) {
    throw error(404, { message: "Monitor not found" });
  }

  const monitorBar = await buildMonitorBarResponse(monitor, days, serverEndOfDayTodayAtTz);

  return {
    monitorTag: tag,
    days,
    height,
    theme,
    metric,
    serverEndOfDayTodayAtTz,
    monitorBar,
  };
};
