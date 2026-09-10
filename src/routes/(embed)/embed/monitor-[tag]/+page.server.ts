import { ResolveVisiblePublicMonitor } from "$lib/server/controllers/publicMonitorResolver";
import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import db from "$lib/server/db/db";
import { buildMonitorBarResponse, endOfDayAtTz } from "$lib/server/api-server/monitor-bar/shared";

const DEFAULT_DAYS = 90;
const MAX_DAYS = 90;

export const load: PageServerLoad = async ({ params, url }) => {
  const { tag } = params;
  const theme = url.searchParams.get("theme");
  const daysParam = url.searchParams.get("days");
  const days = Math.min(MAX_DAYS, Math.max(1, daysParam ? parseInt(daysParam, 10) : DEFAULT_DAYS));

  // Day buckets depend on a timezone, and the server does not know the viewer's.
  // An embedder can pin one with ?tz=; otherwise render UTC. The page refetches
  // in the browser only when the viewer's day boundary differs from this one, so
  // a pinned tz (and every UTC viewer) costs no request at all.
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
    theme,
    serverEndOfDayTodayAtTz,
    monitorBar,
  };
};
