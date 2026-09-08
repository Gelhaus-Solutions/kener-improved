import GC from "$lib/global-constants.js";
import { UpdateMonitoringData } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateMonitoringData",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    data.type = GC.MANUAL;
    resp = await UpdateMonitoringData(data);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
