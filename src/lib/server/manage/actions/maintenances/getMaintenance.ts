import { GetMaintenanceWithEvents } from "$lib/server/controllers/maintenanceController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getMaintenance",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await GetMaintenanceWithEvents(data.id);
    if (!resp) {
      throw new Error("Maintenance not found");
    }
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
