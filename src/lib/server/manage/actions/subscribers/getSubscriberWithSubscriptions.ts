import { GetSubscriberWithSubscriptionsV2 } from "$lib/server/controllers/userSubscriptionsController.js";
import { format } from "date-fns";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getSubscriberWithSubscriptions",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    // V2: subscriberId is actually the method_id from subscriber_methods table
    const { subscriberId, method } = data;
    if (!subscriberId || !method) {
      throw new Error("subscriberId and method are required");
    }
    // Use V2 function which expects method_id
    const result = await GetSubscriberWithSubscriptionsV2(subscriberId);
    if (result) {
      // Map V2 result to expected format for compatibility with existing UI
      resp = {
        subscriber: {
          id: result.method.id,
          subscriber_send: result.method.method_value,
          subscriber_meta: result.user.email, // Store user email in meta for display
          subscriber_type: result.method.method_type,
          subscriber_status: result.method.status,
          created_at: result.method.created_at,
          updated_at: result.method.updated_at,
        },
        subscriptions: result.subscriptions.map((s) => ({
          id: s.id,
          subscriber_id: s.subscriber_method_id,
          subscription_method: result.method.method_type,
          event_type: s.event_type,
          status: s.status,
          created_at: s.created_at,
          updated_at: s.updated_at,
        })),
      };
    } else {
      resp = { subscriber: null, subscriptions: [] };
    }
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
