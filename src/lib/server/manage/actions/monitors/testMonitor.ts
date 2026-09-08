import { GetMonitorsParsed } from "$lib/server/controllers/controller.js";
import Service, { type MonitorWithType } from "$lib/server/services/service.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "testMonitor",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    let monitorID = data.monitor_id;
    let monitors = await GetMonitorsParsed({ id: monitorID });
    let monitor = monitors[0];
    if (monitor.monitor_type === "NONE") {
      throw new Error("Tests can't be run on monitor type NONE");
    }
    const monitorReducedType: MonitorWithType = {
      tag: monitor.tag,
      monitor_type: monitor.monitor_type,
      type_data: monitor.type_data,
      cron: monitor.cron ? monitor.cron : undefined,
    };
    const serviceClient = new Service(monitorReducedType);
    resp = await serviceClient.execute();
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
