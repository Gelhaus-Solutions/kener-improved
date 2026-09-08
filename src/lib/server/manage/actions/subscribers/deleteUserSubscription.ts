import { DeleteUserSubscription } from "$lib/server/controllers/userSubscriptionsController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "deleteUserSubscription",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const { subscriptionId } = data;
    if (!subscriptionId) {
      throw new Error("subscriptionId is required");
    }
    resp = await DeleteUserSubscription(subscriptionId);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
