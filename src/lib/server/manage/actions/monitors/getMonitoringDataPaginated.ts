import { isMonitoringStatus } from "$lib/global-constants.js";
import { GetMonitoringDataPaginated } from "$lib/server/controllers/controller.js";
import { type MonitoringStatus } from "$lib/types/status.js";
import { json } from "@sveltejs/kit";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getMonitoringDataPaginated",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const page = parseInt(String(data.page)) || 1;
    const limit = parseInt(String(data.limit)) || 50;
    const filter: { monitor_tag?: string; status?: MonitoringStatus; start_time?: number; end_time?: number } = {};
    if (data.monitor_tag && data.monitor_tag !== "ALL") {
      filter.monitor_tag = data.monitor_tag;
    }
    if (data.status !== undefined && data.status !== null && data.status !== "ALL") {
      if (!isMonitoringStatus(data.status)) {
        return json({ error: "Invalid monitoring status" }, { status: 400 });
      }
      filter.status = data.status;
    }
    if (data.start_time) {
      filter.start_time = parseInt(String(data.start_time));
    }
    if (data.end_time) {
      filter.end_time = parseInt(String(data.end_time));
    }
    resp = await GetMonitoringDataPaginated(page, limit, Object.keys(filter).length > 0 ? filter : undefined);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
