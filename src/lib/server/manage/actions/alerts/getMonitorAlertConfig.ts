import { GetMonitorAlertConfigById } from "$lib/server/controllers/monitorAlertConfigController.js";
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
    resp = await GetMonitorAlertConfigById(data.id);
    if (!resp) {
      throw new Error("Monitor alert config not found");
    }
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
