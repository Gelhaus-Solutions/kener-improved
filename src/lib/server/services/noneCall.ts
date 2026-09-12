import { GetLastKnownStatus } from "../controllers/monitorsController.js";
import type { NoneMonitor, MonitoringResult } from "../types/monitor.js";
import GC from "../../global-constants.js";

class NoneCall {
  monitor: NoneMonitor;

  constructor(monitor: NoneMonitor) {
    this.monitor = monitor;
  }

  async execute(): Promise<MonitoringResult | null> {
    let overrideWithLastKnownStatus = this.monitor.type_data.overrideWithLastKnownStatus;
    if (!!overrideWithLastKnownStatus) {
      //get the last known status
      let lastKnownStatus = await GetLastKnownStatus(this.monitor.tag);
      if (
        !!lastKnownStatus &&
        !!lastKnownStatus.status &&
        !!lastKnownStatus.type &&
        // Both, since KENER-123 split them. A NONE monitor has no checks of its
        // own, so its status is whatever was last put there - by the data API
        // (MANUAL) or by an operator on the admin screen (OPERATOR). Before the
        // split both wrote MANUAL and both held; accepting only one here would
        // silently stop an operator-set NONE monitor from keeping its status.
        (lastKnownStatus.type === GC.MANUAL || lastKnownStatus.type === GC.OPERATOR)
      ) {
        return {
          status: lastKnownStatus.status,
          latency: lastKnownStatus.latency || 0,
          type: lastKnownStatus.type,
        };
      }
    }
    return null;
  }
}

export default NoneCall;
