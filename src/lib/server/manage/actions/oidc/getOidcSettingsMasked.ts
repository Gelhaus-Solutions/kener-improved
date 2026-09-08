import { GetSiteDataByKey } from "$lib/server/controllers/controller.js";
import { MaskString } from "$lib/server/tool.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getOidcSettingsMasked",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const raw = await GetSiteDataByKey("oidcSettings");
    if (raw && typeof raw === "object") {
      const settings = { ...(raw as Record<string, unknown>) };
      if (settings.client_secret && typeof settings.client_secret === "string") {
        settings.client_secret = MaskString(settings.client_secret);
      }
      resp = settings;
    } else {
      resp = raw;
    }
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
