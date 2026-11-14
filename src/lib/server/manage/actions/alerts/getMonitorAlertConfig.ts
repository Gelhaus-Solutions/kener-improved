import { GetMonitorAlertConfigById } from "$lib/server/controllers/monitorAlertConfigController.js";
import { MaskAlertConfigTriggerSecrets } from "$lib/server/controllers/triggerController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 *
 * The inherited chain answered this one branch for two action strings, so both
 * are registered rather than duplicating the handler or silently dropping one.
 */
export default {
  action: "getMonitorAlertConfig",
  aliases: ["getMonitorAlertConfigById"],
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const config = await GetMonitorAlertConfigById(data.id);
    if (!config) {
      throw new Error("Monitor alert config not found");
    }
    resp = MaskAlertConfigTriggerSecrets(config);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
