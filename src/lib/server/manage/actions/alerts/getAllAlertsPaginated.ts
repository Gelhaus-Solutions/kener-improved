import { GetMonitorAlertsV2Paginated } from "$lib/server/controllers/monitorAlertConfigController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getAllAlertsPaginated",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const page = parseInt(String(data.page)) || 1;
    const limit = parseInt(String(data.limit)) || 20;
    const filter: { alert_status?: "TRIGGERED" | "RESOLVED"; config_id?: number } = {};
    if (data.status && data.status !== "ALL") filter.alert_status = data.status as "TRIGGERED" | "RESOLVED";
    if (data.config_id) filter.config_id = parseInt(String(data.config_id));
    resp = await GetMonitorAlertsV2Paginated(page, limit, Object.keys(filter).length > 0 ? filter : undefined);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
