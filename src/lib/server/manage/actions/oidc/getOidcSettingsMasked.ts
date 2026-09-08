import { GetSiteDataByKey } from "$lib/server/controllers/controller.js";
import { MaskString } from "$lib/server/tool.js";
import { isSealed } from "$lib/server/crypto/secretBox.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain, with one change: a client secret
 * is now stored encrypted, and masking a ciphertext would show the operator four
 * characters of base64 that match nothing they ever typed. A sealed value is
 * reported as a fixed placeholder instead, which is honest about there being one
 * without pretending to describe it.
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
        settings.client_secret = isSealed(settings.client_secret)
          ? "********"
          : // Written before encryption existed. Masked as it always was, until
            // the settings are next saved or the migration rewrites the row.
            MaskString(settings.client_secret);
      }
      resp = settings;
    } else {
      resp = raw;
    }
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
