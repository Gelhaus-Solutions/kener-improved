import { UpdateMonitorAlertV2Status } from "$lib/server/controllers/monitorAlertConfigController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateMonitorAlertV2Status",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await UpdateMonitorAlertV2Status(data.id, data.status);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
