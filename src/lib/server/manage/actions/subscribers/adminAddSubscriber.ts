import { AdminAddSubscriber } from "$lib/server/controllers/userSubscriptionsController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "adminAddSubscriber",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const { email, incidents, maintenances } = data;
    if (!email) {
      throw new Error("Email is required");
    }
    resp = await AdminAddSubscriber(email, incidents ?? false, maintenances ?? false);
    if (!resp.success) {
      throw new Error(resp.error);
    }
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
