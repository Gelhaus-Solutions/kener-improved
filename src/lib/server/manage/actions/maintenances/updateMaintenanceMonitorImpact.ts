import { UpdateMaintenanceMonitorImpact } from "$lib/server/controllers/maintenanceController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateMaintenanceMonitorImpact",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    await UpdateMaintenanceMonitorImpact(data.maintenance_id, data.monitor_tag, data.monitor_impact);
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
