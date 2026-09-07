import { GetAllSiteData } from "$lib/server/controllers/controller.js";
import type { ActionDefinition } from "../../types.js";

/**
 * Note there is no `permission` here. The pipeline resolves it from
 * ACTION_PERMISSION_MAP, which maps this action to `settings.read`. Repeating it
 * in this file would create a second place for it to be wrong, and would stop
 * upstream's edits to that map from taking effect.
 */
export default {
  action: "getAllSiteData",
  handler: async () => await GetAllSiteData(),
} satisfies ActionDefinition;
