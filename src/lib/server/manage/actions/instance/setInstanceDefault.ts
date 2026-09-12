import db from "$lib/server/db/db.js";
import { siteDataKeys } from "$lib/server/controllers/siteDataKeys.js";
import { isInstanceScoped } from "$lib/server/controllers/siteDataScope.js";
import { InvalidateInstanceSiteDataCache } from "$lib/server/cache/siteDataCache.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  key?: string;
  value?: string;
}

/**
 * I3g. Writes one value into the instance layer.
 *
 * Validated against the same `siteDataKeys` registry as every other write, so a
 * value that would be rejected on a tenant's settings screen cannot be smuggled
 * in as a default. The registry is also what makes an unknown key an error
 * rather than a new row nothing ever reads.
 *
 * **Invalidates every org, not just one.** The value written here is what every
 * org that has not overridden the key reads through the overlay, so invalidating
 * the caller's own cache entry would leave every other tenant serving the old
 * default until the Redis TTL expired. That is true whether or not the key is
 * instance-scoped: an ordinary key's default is still read by every org that
 * never changed it.
 */
export default {
  action: "setInstanceDefault",
  permission: null,
  superadmin: true,
  audit: { targetType: "site_data" },
  handler: async (data: Payload) => {
    const key = String(data.key ?? "").trim();
    if (!key) throw new ActionError(400, "key is required");

    const entry = siteDataKeys.find((k) => k.key === key);
    if (!entry) throw new ActionError(400, `Unknown setting: ${key}`);

    const value = typeof data.value === "string" ? data.value : "";
    if (!entry.isValid(value)) throw new ActionError(400, `That is not a valid value for ${key}`);

    await db.setInstanceSiteData(key, value, entry.data_type);
    await InvalidateInstanceSiteDataCache();

    return { success: true, key, instance_scoped: isInstanceScoped(key) };
  },
} satisfies ActionDefinition<Payload>;
