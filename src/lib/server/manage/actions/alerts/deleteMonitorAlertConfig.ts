import { DeleteMonitorAlertConfig } from "$lib/server/controllers/monitorAlertConfigController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "deleteMonitorAlertConfig",
  audit: { targetType: "alert_config" },
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    await DeleteMonitorAlertConfig(data.id);
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
