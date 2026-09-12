import GC from "../../global-constants.js";
import { GetNowTimestampUTCInMs } from "../tool.js";
import { GetLastHeartbeat as GetLastHeartbeatFromCache } from "../cache/setGet.js";
import type { HeartbeatMonitor, MonitoringResult } from "../types/monitor.js";
import { GetLastHeartbeat as GetLastHeartbeatFromDb } from "../controllers/monitorsController.js";
import { evaluateSchedule } from "./heartbeatSchedule.js";

function toMs(ts: number): number {
  // Cache historically stored ms, DB stores seconds.
  return ts >= 1_000_000_000_000 ? ts : ts * 1000;
}

/**
 * B11. Render an instant in the schedule's own timezone.
 *
 * The message has to name a wall-clock time the operator recognises: someone
 * who wrote "02:00 Europe/Berlin" should be told 02:00, not the UTC instant it
 * happens to land on. Intl with an explicit `timeZone` is independent of the
 * host's TZ, which the web and scheduler processes do not agree on.
 */
function inZone(utcSeconds: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
      hour12: false,
    }).format(new Date(utcSeconds * 1000));
  } catch {
    return new Date(utcSeconds * 1000).toISOString();
  }
}

class HeartbeatCall {
  monitor: HeartbeatMonitor;

  constructor(monitor: HeartbeatMonitor) {
    this.monitor = monitor;
  }

  async execute(): Promise<MonitoringResult> {
    const nowMs = GetNowTimestampUTCInMs();

    const cached = await GetLastHeartbeatFromCache(this.monitor.tag);
    let lastHeartbeatMs: number | null = cached?.timestamp != null ? toMs(cached.timestamp) : null;
    let exitCode: number | undefined = cached?.exitCode;
    let durationMs: number | undefined = cached?.durationMs;

    if (lastHeartbeatMs == null) {
      const dbSignal = await GetLastHeartbeatFromDb(this.monitor.tag);
      lastHeartbeatMs = dbSignal?.timestamp != null ? toMs(dbSignal.timestamp) : null;
      // The signal row is the only record that survives a cache flush, so a run
      // that reported failure has to be recoverable from its status.
      if (lastHeartbeatMs != null && dbSignal?.status === GC.DOWN) exitCode = 1;
      if (lastHeartbeatMs != null && dbSignal?.latency) durationMs = dbSignal.latency;
    }

    if (lastHeartbeatMs == null) {
      return {
        status: GC.NO_DATA,
        latency: 0,
        type: GC.REALTIME,
        error_message: "No heartbeat received yet",
      };
    }

    const diffInMs = Math.max(0, nowMs - lastHeartbeatMs);
    // B11. When the job told us how long it took, that is the number worth
    // charting. Otherwise keep the original meaning, time since the last ping.
    const latency = durationMs !== undefined ? durationMs : diffInMs;

    // B11. An explicit failure outranks the schedule. The job ran, and said it
    // broke - silence-based rules cannot see that, and would call it healthy.
    if (exitCode !== undefined && exitCode !== 0) {
      return {
        status: GC.DOWN,
        latency,
        type: GC.REALTIME,
        error_message: `Last run reported failure (exit code ${exitCode})`,
      };
    }

    const pattern = this.monitor.type_data?.expectedCron?.trim();
    if (pattern) {
      const timezone = this.monitor.type_data?.cronTimezone?.trim() || "UTC";
      const graceMinutes = Number(this.monitor.type_data?.graceMinutes ?? 5);
      const graceSeconds = (Number.isFinite(graceMinutes) && graceMinutes >= 0 ? graceMinutes : 5) * 60;

      const verdict = evaluateSchedule({
        pattern,
        timezone,
        graceSeconds,
        nowSec: Math.floor(nowMs / 1000),
        lastSec: Math.floor(lastHeartbeatMs / 1000),
      });

      if (verdict.state === "INVALID") {
        // A typo in the pattern must not take the monitor down. Fall through to
        // the interval thresholds, which is what it did before B11.
        console.error(
          `Heartbeat monitor ${this.monitor.tag} has an unusable schedule ("${pattern}", ${timezone}): ${verdict.reason}. Falling back to the interval thresholds.`,
        );
      } else if (verdict.state === "ON_TIME" || verdict.state === "IN_GRACE") {
        return { status: GC.UP, latency, type: GC.REALTIME };
      } else {
        const due = verdict.expectedAt !== null ? inZone(verdict.expectedAt, timezone) : "its expected time";
        return {
          status: verdict.state === "LATE" ? GC.DEGRADED : GC.DOWN,
          latency,
          type: GC.REALTIME,
          error_message:
            verdict.state === "LATE"
              ? `No heartbeat for the run expected at ${due} (${timezone}), ${graceMinutes} minute grace exceeded`
              : `No heartbeat for the last ${verdict.missedWindows} expected runs, most recently ${due} (${timezone})`,
        };
      }
    }

    const downMinutes = Number(this.monitor.type_data?.downRemainingMinutes ?? 10);
    const degradedMinutes = Number(this.monitor.type_data?.degradedRemainingMinutes ?? 5);
    const downThresholdMs = (Number.isFinite(downMinutes) ? downMinutes : 10) * 60 * 1000;
    const degradedThresholdMs = (Number.isFinite(degradedMinutes) ? degradedMinutes : 5) * 60 * 1000;

    if (diffInMs > downThresholdMs) {
      return {
        status: GC.DOWN,
        latency,
        type: GC.REALTIME,
        error_message: `No heartbeat received in the last ${downMinutes} minutes`,
      };
    }

    if (diffInMs > degradedThresholdMs) {
      return {
        status: GC.DEGRADED,
        latency,
        type: GC.REALTIME,
        error_message: `No heartbeat received in the last ${degradedMinutes} minutes`,
      };
    }

    return {
      status: GC.UP,
      latency,
      type: GC.REALTIME,
    };
  }
}

export default HeartbeatCall;
