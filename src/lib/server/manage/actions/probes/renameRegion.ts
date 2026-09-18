import db from "$lib/server/db/db.js";
import { MERGED_REGION_ID, normalizeRegionCode } from "$lib/server/db/regions.js";
import { LOCAL_REGION_ID } from "$lib/server/probes/merge.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  region_id?: number;
  code?: string;
  name?: string;
  description?: string | null;
}

/**
 * Renames a region, in place.
 *
 * **Why in place, rather than creating the new region and moving everything to
 * it.** The obvious reading of "you cannot just rename a slug" is that the slug
 * is an identifier something depends on, so a rename has to be a migration.
 * Here it is not. `regions.code` is referenced in exactly two places, a
 * uniqueness check and a screen label; agents, assignments, region rules,
 * overrides and every row in `monitoring_data` reference `region_id`, an
 * integer that this action never touches.
 *
 * So a move would be the destructive option, not the safe one. A new region
 * means a new `region_id`, and every sample already written carries the old one:
 * the history for that vantage point would stay behind, keyed to a region that
 * no longer appears on any screen, while the renamed region started from an
 * empty chart. Renaming the row keeps the id, and therefore keeps the history.
 *
 * **The merged verdict is refused; the local check is renameable in part.**
 * `merged` (0) is the computed answer across the other regions, it appears on no
 * map and no public surface, and there is nothing for an operator to call it.
 *
 * `local` (-1) is different and used to be refused for the same reasons, which
 * was wrong. It is a real vantage point - this server, wherever you run it - and
 * since B13 it is drawn on the map and listed on the PUBLIC status page. A
 * hardcoded "Local check" was therefore appearing in front of visitors with no
 * way to change it. Its NAME and DESCRIPTION are now the operator's.
 *
 * **Its CODE is not.** `code` is an identifier: `coordinatesForCode` keys the
 * built-in location lookup on it, and the reserved rows carry a null org so the
 * usual per-org uniqueness does not protect them. The id is what the merge
 * reasons about either way, so nothing is gained by letting the code move.
 */
export default {
  action: "renameRegion",
  audit: { targetType: "region" },
  handler: async (data: Payload) => {
    const regionId = Number(data.region_id);
    if (!Number.isFinite(regionId)) throw new ActionError(400, "region_id is required");

    if (regionId === MERGED_REGION_ID) {
      throw new ActionError(400, "The merged verdict is computed from the other regions and has no name of its own");
    }

    // The local check keeps its identifier and gains a display name. See above.
    if (regionId === LOCAL_REGION_ID && data.code !== undefined) {
      throw new ActionError(400, "The local check's code is built in; its name can be changed");
    }

    // Org-visible regions only. This is what stops one tenant renaming another's
    // region by guessing an id: the read filters to the caller's org.
    const region = (await db.getMergeRegions()).find((r) => r.id === regionId);
    if (!region) throw new ActionError(404, "That region does not exist");

    const patch: { code?: string; name?: string; description?: string | null } = {};

    if (data.name !== undefined) {
      const name = String(data.name).trim();
      if (!name) throw new ActionError(400, "A region name is required");
      patch.name = name;
    }

    if (data.code !== undefined) {
      const code = normalizeRegionCode(data.code);
      if (!code) throw new ActionError(400, "A region code is required, using letters, numbers and hyphens");

      // Only when it actually changed. Checking unconditionally would refuse a
      // rename of the name alone, because the region's own code is of course
      // already taken, by itself.
      if (code !== region.code) {
        if (await db.regionCodeExists(code)) {
          throw new ActionError(409, `The region code "${code}" is already in use`);
        }
        patch.code = code;
      }
    }

    if (data.description !== undefined) {
      const description = data.description === null ? null : String(data.description).trim();
      patch.description = description ? description : null;
    }

    if (Object.keys(patch).length === 0) return { success: true, changed: 0 };

    const changed = await db.updateRegion(regionId, patch);
    return { success: true, changed, code: patch.code ?? region.code };
  },
} satisfies ActionDefinition<Payload>;
