import { ToggleMonitorAlertConfigStatus } from "$lib/server/controllers/monitorAlertConfigController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "toggleMonitorAlertConfigStatus",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await ToggleMonitorAlertConfigStatus(data.id);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
