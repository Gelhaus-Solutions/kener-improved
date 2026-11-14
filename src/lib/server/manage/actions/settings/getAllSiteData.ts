import { GetAllSiteData, MaskSiteDataSecret } from "$lib/server/controllers/controller.js";
import type { ActionDefinition } from "../../types.js";

/**
 * Note there is no `permission` here. The pipeline resolves it from
 * ACTION_PERMISSION_MAP, which maps this action to `settings.read`. Repeating it
 * in this file would create a second place for it to be wrong, and would stop
 * upstream's edits to that map from taking effect.
 */
export default {
  action: "getAllSiteData",
  // Upstream 66946f31: a stored secret never leaves the server unmasked.
  handler: async () =>
    Object.fromEntries(
      Object.entries(await GetAllSiteData()).map(([key, value]) => [key, MaskSiteDataSecret(key, value)]),
    ),
} satisfies ActionDefinition;
