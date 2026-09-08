import { GetAdminSubscribersPaginated } from "$lib/server/controllers/userSubscriptionsController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getAdminSubscribers",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const page = parseInt(String(data.page)) || 1;
    const limit = parseInt(String(data.limit)) || 10;
    resp = await GetAdminSubscribersPaginated(page, limit);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
