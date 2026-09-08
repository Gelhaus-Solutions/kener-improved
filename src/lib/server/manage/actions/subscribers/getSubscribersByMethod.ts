import { GetSubscribersByMethod } from "$lib/server/controllers/userSubscriptionsController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getSubscribersByMethod",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const { method, page = 1, limit = 25 } = data;
    if (!method) {
      throw new Error("Method is required");
    }
    resp = await GetSubscribersByMethod(method, page, limit);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
