import { GetMonitorAlertConfigsPaginated } from "$lib/server/controllers/monitorAlertConfigController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getAlertConfigsPaginated",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const page = parseInt(String(data.page)) || 1;
    const limit = parseInt(String(data.limit)) || 10;
    const filter: { monitor_tag?: string; is_active?: "YES" | "NO"; alert_for?: "STATUS" | "LATENCY" | "UPTIME" } =
      {};
    if (data.monitor_tag) filter.monitor_tag = data.monitor_tag;
    if (data.is_active) filter.is_active = data.is_active as "YES" | "NO";
    if (data.alert_for) filter.alert_for = data.alert_for as "STATUS" | "LATENCY" | "UPTIME";
    resp = await GetMonitorAlertConfigsPaginated(page, limit, Object.keys(filter).length > 0 ? filter : undefined);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
