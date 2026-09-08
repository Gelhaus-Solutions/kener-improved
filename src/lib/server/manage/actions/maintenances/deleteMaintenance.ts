import { DeleteMaintenance } from "$lib/server/controllers/maintenanceController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "deleteMaintenance",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    await DeleteMaintenance(data.id);
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
