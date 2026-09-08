import { GetSiteDataByKey } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getSubscriptionsConfig",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    let subscriptionsSettings = await GetSiteDataByKey("subscriptionsSettings");
    if (!!!subscriptionsSettings) {
      subscriptionsSettings = {
        enable: false,
        methods: {
          emails: {
            incidents: true,
            maintenances: true,
          },
        },
      };
    }
    resp = subscriptionsSettings;
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
