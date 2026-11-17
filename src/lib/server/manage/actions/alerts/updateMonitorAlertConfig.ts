import { UpdateMonitorAlertConfig } from "$lib/server/controllers/monitorAlertConfigController.js";
import { MaskAlertConfigTriggerSecrets } from "$lib/server/controllers/triggerController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateMonitorAlertConfig",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = MaskAlertConfigTriggerSecrets(await UpdateMonitorAlertConfig(data));
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
