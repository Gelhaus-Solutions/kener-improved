import axios from "axios";
import constants from "../global-constants.js";
import { GetMinuteStartNowTimestampUTC, ReplaceAllOccurrences, GetRequiredSecrets, Wait } from "./tool.js";
import monitorExecuteQueue from "./queues/monitorExecuteQueue";

import dotenv from "dotenv";
import db from "./db/db.js";
import type { MonitorRecordTyped } from "./types/db.js";

import type { MonitoringResult } from "./types/monitor.js";
import { MONITOR_TYPES, type MonitorType } from "../types/monitor.js";
import type { JobsOptions } from "bullmq";

dotenv.config();

/**
 * B12b. How long a multi-region rollup waits for its regional endpoints.
 *
 * One second, matching GROUP's default. The endpoints are pushed onto the same
 * queue in the same tick, so this is a dispatch-ordering gap rather than time
 * for a check to complete: a region that has not answered yet simply carries its
 * previous sample, which the freshness window in `multiRegionCall.ts` still
 * accepts.
 */
const MULTI_REGION_EXECUTION_DELAY_MS = 1000;
const Minuter = async (monitor: MonitorRecordTyped) => {
  if (!MONITOR_TYPES.includes(monitor.monitor_type as MonitorType)) {
    throw new Error(`Invalid monitor type: ${monitor.monitor_type}. Valid types are: ${MONITOR_TYPES.join(", ")}`);
  }
  const startOfMinute = GetMinuteStartNowTimestampUTC();
  let options: JobsOptions | undefined = undefined;
  if (monitor.monitor_type === "GROUP") {
    options = {
      delay: parseInt(String(monitor.type_data?.executionDelay)) || 1000, // default 1 second delay for group monitors
    };
  } else if (monitor.monitor_type === "MULTI_REGION") {
    // B12b. Same reason as GROUP: this monitor summarises others scheduled in
    // the same tick, so without a delay it reads their PREVIOUS minute and the
    // service's status trails its regions by one check. Not configurable, unlike
    // GROUP's, because a multi-region monitor's endpoints are its own children
    // rather than arbitrary monitors an operator picked, and they are dispatched
    // by this same loop.
    options = { delay: MULTI_REGION_EXECUTION_DELAY_MS };
  }
  await monitorExecuteQueue.push(monitor, startOfMinute, options);
};

export { Minuter };
