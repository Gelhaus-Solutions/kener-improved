import { GetSiteDataByKey } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getSiteDataByKey",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const { key } = data;
    if (!key) {
      throw new Error("Key is required");
    }
    let siteData = await GetSiteDataByKey(key);
    if (!!!siteData) {
      throw new Error("Site data not found for the given key");
    }
    resp = siteData;
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
