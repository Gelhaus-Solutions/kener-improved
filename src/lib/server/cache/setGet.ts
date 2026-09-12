import type { MonitoringData } from "../types/db.js";
import { setCache, getCache, deleteCache } from "./cache.js";
export async function SetLastMonitoringValue(tag: string, value: MonitoringData): Promise<void> {
  await setCache<MonitoringData>(tag + ":last_status", value, 86400); //set ttl to 1 day
}

export async function GetLastMonitoringValue(
  tag: string,
  fetcher?: () => Promise<MonitoringData | undefined | null> | MonitoringData | undefined | null,
): Promise<MonitoringData | null> {
  return await getCache<MonitoringData>(tag + ":last_status", fetcher, 86400);
}

/**
 * B11. What the last ping told us. `exitCode` and `durationMs` are optional
 * because a plain GET carries neither, and because values cached before B11
 * have only the timestamp. Absent means "the job did not say", never "zero".
 */
export interface LastHeartbeat {
  timestamp: number;
  exitCode?: number;
  durationMs?: number;
}

//function to set heartbeat value in cache
export async function SetLastHeartbeat(
  tag: string,
  timestamp: number,
  extra?: { exitCode?: number; durationMs?: number },
): Promise<void> {
  const value: LastHeartbeat = { timestamp };
  if (extra?.exitCode !== undefined) value.exitCode = extra.exitCode;
  if (extra?.durationMs !== undefined) value.durationMs = extra.durationMs;
  await setCache<LastHeartbeat>("last_heartbeat:" + tag, value, 45 * 86400); //set ttl to 45 days
}

//function to get heartbeat value from cache
export async function GetLastHeartbeat(tag: string): Promise<LastHeartbeat | null> {
  return await getCache<LastHeartbeat>("last_heartbeat:" + tag, undefined, 45 * 86400);
}

export async function DeleteMonitorCaches(tag: string): Promise<void> {
  await deleteCache(tag + ":last_status");
  await deleteCache("last_heartbeat:" + tag);
}
