import { AdminDeleteSubscriber } from "$lib/server/controllers/userSubscriptionsController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "adminDeleteSubscriber",
  audit: { targetType: "subscriber" },
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const { methodId } = data;
    if (!methodId) {
      throw new Error("Method ID is required");
    }
    resp = await AdminDeleteSubscriber(methodId);
    if (!resp.success) {
      throw new Error(resp.error);
    }
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
