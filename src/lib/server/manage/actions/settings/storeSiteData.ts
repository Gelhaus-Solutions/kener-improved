import { GetSiteDataByKey, InsertKeyValue } from "$lib/server/controllers/controller.js";
import { ClearOidcConfigCache, OIDC_SECRET_PURPOSE } from "$lib/server/controllers/oidcController.js";
import { sealIfPlain } from "$lib/server/crypto/secretBox.js";
import {
  SITE_DATA_KEY as LATENCY_THRESHOLD_KEY,
  invalidateLatencyThresholdCache,
} from "$lib/server/services/latencyThreshold.js";
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
              // Already encrypted on the way in, so carrying it forward keeps it
              // encrypted; sealIfPlain below is a no-op for it.
              newSettings.client_secret = (existing as Record<string, unknown>).client_secret;
            }
          }
          // Encrypted before it reaches the database. This is the only write
          // path for the key, so sealing here is what makes "no plaintext
          // client secret in site_data" true rather than aspirational.
          if (typeof newSettings.client_secret === "string" && newSettings.client_secret.length > 0) {
            newSettings.client_secret = sealIfPlain(newSettings.client_secret, OIDC_SECRET_PURPOSE);
          }
          element = JSON.stringify(newSettings);
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

      // B5's threshold has its own 10-second per-process memo, because it is
      // read on every check of every monitor. `InvalidateSiteDataCache` inside
      // InsertKeyValue does not reach it, so without this the operator saves a
      // rule and watches the old one keep deciding for another ten seconds.
      if (key === LATENCY_THRESHOLD_KEY) {
        invalidateLatencyThresholdCache();
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
