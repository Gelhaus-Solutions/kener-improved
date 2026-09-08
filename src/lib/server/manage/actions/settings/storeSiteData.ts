import { GetSiteDataByKey, InsertKeyValue } from "$lib/server/controllers/controller.js";
import { ClearOidcConfigCache } from "$lib/server/controllers/oidcController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

async function storeSiteData(data: { [x: string]: any }) {
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      let element = data[key];
      if (key === "socialPreviewImage" && (element === null || element === undefined)) {
        element = "";
      }
      // If oidcSettings is saved without client_secret, preserve the existing one.
      // An explicit empty string clears it.
      if (key === "oidcSettings" && typeof element === "string") {
        try {
          const newSettings = JSON.parse(element);
          if (newSettings.client_secret === undefined) {
            const existing = await GetSiteDataByKey("oidcSettings");
            if (existing && typeof existing === "object") {
              newSettings.client_secret = (existing as Record<string, unknown>).client_secret;
              element = JSON.stringify(newSettings);
            }
          }
        } catch {
          // If parsing fails, proceed with the original value
        }
      }
      await InsertKeyValue(key, element);

      // Clear OIDC config cache when settings change so logins
      // pick up new credentials immediately
      if (key === "oidcSettings") {
        ClearOidcConfigCache();
      }
    }
  }
  return { success: true };
}

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "storeSiteData",
  audit: { targetType: "site_data" },
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await storeSiteData(data);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
