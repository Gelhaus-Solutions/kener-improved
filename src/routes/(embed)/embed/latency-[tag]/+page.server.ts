import { ResolveVisiblePublicMonitor } from "$lib/server/controllers/publicMonitorResolver";
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

  // I3e: the embed URL carries the per-org slug; identical to the tag for the
  // default org, so existing embed snippets keep working.
  // Visible, not merely existing (KENER-126): an embed is a public surface, and
  // this one rendered a hidden monitor's whole bar to anyone who framed it.
  const monitor = await ResolveVisiblePublicMonitor(tag);
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
