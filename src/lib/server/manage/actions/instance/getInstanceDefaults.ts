import db from "$lib/server/db/db.js";
import { siteDataKeys } from "$lib/server/controllers/siteDataKeys.js";
import { INSTANCE_SCOPED_KEYS } from "$lib/server/controllers/siteDataScope.js";
import type { ActionDefinition } from "../../types.js";

/**
 * I3g. The instance layer's `site_data`, for the instance console.
 *
 * **Reads the layer itself, not through the overlay.** Every other reader wants
 * the effective value for its org; this one is editing the default that value
 * falls back to, so seeing an org's override here would be actively wrong.
 *
 * Superadmin only, for the same reason as the rest of the console: these values
 * are the starting point for every tenant, and `mfaPolicy` or `oidcSettings`
 * decide how people log in to all of them. No per-org permission could be the
 * right gate, because granting it would hand one tenant's administrator the
 * whole instance.
 */
export default {
  action: "getInstanceDefaults",
  permission: null,
  superadmin: true,
  handler: async () => {
    const rows = await db.getInstanceSiteData();
    const byKey = new Map(rows.map((row) => [row.key, row]));

    // Driven by the key registry rather than by the rows, so a key that has
    // somehow never been written still appears - as empty, which is the honest
    // answer and the one an operator can act on.
    const keys = siteDataKeys.map((entry) => {
      const row = byKey.get(entry.key);
      return {
        key: entry.key,
        data_type: entry.data_type,
        value: row?.value ?? null,
        instance_scoped: INSTANCE_SCOPED_KEYS.has(entry.key),
      };
    });

    return {
      keys,
      // So the screen can say which of the two things editing a key does: change
      // a default that tenants may override, or change a setting outright.
      instance_scoped_keys: [...INSTANCE_SCOPED_KEYS],
    };
  },
} satisfies ActionDefinition;
