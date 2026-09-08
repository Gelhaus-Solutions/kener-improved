import { RemoveMonitorFromMaintenance } from "$lib/server/controllers/maintenanceController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "removeMonitorFromMaintenance",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    await RemoveMonitorFromMaintenance(data.maintenance_id, data.monitor_tag);
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
