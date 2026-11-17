import { GetMonitorAlertConfigsByMonitorTag } from "$lib/server/controllers/monitorAlertConfigController.js";
import { MaskAlertConfigTriggerSecrets } from "$lib/server/controllers/triggerController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getMonitorAlertConfigsByMonitorTag",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = (await GetMonitorAlertConfigsByMonitorTag(data.monitor_tag)).map(MaskAlertConfigTriggerSecrets);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
