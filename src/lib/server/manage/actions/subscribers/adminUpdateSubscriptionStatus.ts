import { AdminUpdateSubscriptionStatus } from "$lib/server/controllers/userSubscriptionsController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "adminUpdateSubscriptionStatus",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const { methodId, eventType, enabled } = data;
    if (!methodId || !eventType) {
      throw new Error("Method ID and event type are required");
    }
    resp = await AdminUpdateSubscriptionStatus(methodId, eventType, enabled);
    if (!resp.success) {
      throw new Error(resp.error);
    }
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
