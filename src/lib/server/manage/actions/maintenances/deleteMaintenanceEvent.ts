import { DeleteMaintenanceEvent } from "$lib/server/controllers/maintenanceController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "deleteMaintenanceEvent",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    await DeleteMaintenanceEvent(data.id);
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
