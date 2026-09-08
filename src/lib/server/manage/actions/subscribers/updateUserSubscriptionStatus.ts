import { UpdateUserSubscriptionStatus } from "$lib/server/controllers/userSubscriptionsController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateUserSubscriptionStatus",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const { subscriptionId, status } = data;
    if (!subscriptionId || !status) {
      throw new Error("subscriptionId and status are required");
    }
    resp = await UpdateUserSubscriptionStatus(subscriptionId, status);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
