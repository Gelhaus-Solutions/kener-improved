import db from "../db/db.js";
import { GetInstanceRole, type InstanceRole } from "./config.js";

export interface InstanceHealth {
  role: InstanceRole;
  /** False on a standby whose data is stale; a failover layer sends traffic elsewhere. */
  ok: boolean;
  lastPullAt?: number | null;
  dataAt?: number | null;
  /** Seconds since the last good pull, the figure the stale threshold is compared with. */
  dataAgeSeconds?: number | null;
  staleAfterSeconds?: number;
  stale?: boolean;
  lastAttemptAt?: number | null;
  /** Whether the latest attempt failed; the reason is in the log. */
  lastAttemptFailed?: boolean;
}

/** GET /healthcheck/instance. */
export async function GetInstanceHealth(): Promise<InstanceHealth> {
  const role = GetInstanceRole();
  if (role !== "standby") return { role, ok: true };
  const freshness = await db.getStandbyFreshness();
  if (!freshness) return { role, ok: false, stale: true };
  return {
    role,
    ok: !freshness.stale,
    lastPullAt: freshness.lastPullAt,
    dataAt: freshness.dataAt,
    dataAgeSeconds: freshness.ageSeconds,
    staleAfterSeconds: freshness.staleAfterSeconds,
    stale: freshness.stale,
    lastAttemptAt: freshness.lastAttemptAt,
    lastAttemptFailed: freshness.lastError !== null,
  };
}
