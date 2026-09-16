import { Cron } from "croner";
import db from "../db/db.js";
import GC from "../../global-constants.js";
import { GetLastMonitoringValue } from "../cache/setGet.js";
import { GetLatestMonitoringData } from "../controllers/monitorsController.js";
import { REGION_FRESHNESS_SECONDS } from "../../regions/mapModel.js";
import { rollupRegionStatuses, type RegionSample } from "../../regions/rollup.js";
import { occurrencesAtOrBefore } from "./heartbeatSchedule.js";
import type { MonitoringResult } from "../types/monitor.js";
import type { MonitorWithType } from "./service.js";

/**
 * B12b. A multi-region service's status, computed from its regional endpoints.
 *
 * **Modelled on `GroupCall` deliberately, and different from it in exactly the
 * ways B12 decided.** Both are monitors that compute rather than check, both
 * read their members' last known values, and both are given a BullMQ delay by
 * `cron-minute.ts` so they run after the things they summarise. What differs is
 * the arithmetic: GROUP is a weighted score an operator configures, and this is
 * a FIXED rule with no weights and no quorum, because a service's regions are
 * not voters disagreeing about one fact. See `regions/rollup.ts`.
 *
 * The rule itself is not here. It is pure, shared with the screen that explains
 * it to an operator, and tested on its own; this class is only the part that has
 * to touch the database.
 */

/**
 * How many of the monitor's own scheduled checks a region may miss before it is
 * treated as silent rather than as still reporting its last answer.
 *
 * **Counted in the monitor's own schedule, not in seconds, and that is the whole
 * point.** A fixed window cannot serve both a service checked every minute and
 * one checked hourly: five minutes marks the hourly one silent on fifty-nine
 * minutes out of sixty, and an hour lets the by-the-minute one hold a stale
 * green for an hour. `occurrencesAtOrBefore` already solves this for B11's
 * heartbeats, including irregular patterns like weekdays-only, so it is reused
 * rather than re-derived.
 *
 * Five, matching `REGION_FRESHNESS_SECONDS` on a one-minute schedule, so the map
 * and the rollup agree about when a region has gone quiet.
 */
const MISSED_CHECKS = 5;

/**
 * The timestamp a region's newest sample must reach to still be believed.
 *
 * Falls back to a flat window when there is no usable cron - a monitor with no
 * schedule, or a pattern croner cannot walk. The fallback is deliberately the
 * same constant the region map uses, so a region that has gone grey on the map
 * is the same region the rollup is ignoring.
 */
function freshnessBoundarySeconds(cronExpression: string | undefined, nowSeconds: number): number {
  const flat = nowSeconds - REGION_FRESHNESS_SECONDS;
  if (!cronExpression) return flat;

  try {
    const occurrences = occurrencesAtOrBefore(new Cron(cronExpression), nowSeconds * 1000, MISSED_CHECKS);
    const oldest = occurrences.at(-1);
    if (oldest === undefined) return flat;
    return Math.floor(oldest / 1000);
  } catch {
    // An unparseable cron is a monitor that should not be running at all, and
    // this is not the place that gets to say so. Fall back rather than throw:
    // a rollup that dies takes the whole service's status with it.
    return flat;
  }
}

class MultiRegionCall {
  monitor: MonitorWithType;

  constructor(monitor: MonitorWithType, _timestamp?: number) {
    this.monitor = monitor;
  }

  async execute(startOfMinute?: number): Promise<MonitoringResult | null> {
    const nowSeconds = startOfMinute ?? Math.floor(Date.now() / 1000);

    const targets = await db.getRegionTargets(this.monitor.tag);
    // **No regions is no sample, not an outage and not health.** A service whose
    // endpoints have all been removed has nothing to report, and writing either
    // UP or DOWN would be inventing an answer. `monitorExecuteQueue` skips a
    // null, so this simply produces no row for the minute.
    if (targets.length === 0) return null;

    const boundary = freshnessBoundarySeconds(this.monitor.cron, nowSeconds);

    const samples: RegionSample[] = [];
    for (const target of targets) {
      const last = await GetLastMonitoringValue(target.child_tag, () => GetLatestMonitoringData(target.child_tag));

      // **Staleness is resolved to null HERE, so the rule never has to know what
      // time it is.** That is what keeps `rollupRegionStatuses` pure and
      // exhaustively testable, and it is the same split B13 uses between
      // `regionMapForMonitor` and `statusFromSample`.
      const fresh = last !== null && typeof last.timestamp === "number" && last.timestamp >= boundary;

      samples.push({
        regionId: target.region_id,
        status: fresh ? (last?.status ?? null) : null,
        latencyMs: fresh ? (last?.latency ?? null) : null,
      });
    }

    const rollup = rollupRegionStatuses(samples);

    // Nothing observable. See the note on `targets.length` above: no row at all
    // beats a confident wrong one.
    if (rollup.status === null) return null;

    return {
      status: rollup.status,
      // A status with no serving region to time is reported as 0 rather than
      // null, because `MonitoringResult.latency` is a number. That case is DOWN
      // or MAINTENANCE, where a latency means nothing anyway.
      latency: rollup.latencyMs ?? 0,
      type: GC.REALTIME,
    };
  }
}

export default MultiRegionCall;
