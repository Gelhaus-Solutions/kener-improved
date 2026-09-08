import { UpdateMaintenanceEventStatus } from "$lib/server/controllers/maintenanceController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateMaintenanceEventStatus",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await UpdateMaintenanceEventStatus(data.id, data.status);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
