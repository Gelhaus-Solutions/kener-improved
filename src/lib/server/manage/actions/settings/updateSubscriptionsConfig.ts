import { InsertKeyValue } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateSubscriptionsConfig",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await InsertKeyValue("subscriptionsSettings", JSON.stringify(data));
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
