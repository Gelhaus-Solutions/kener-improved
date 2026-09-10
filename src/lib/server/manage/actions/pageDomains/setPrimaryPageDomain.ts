import db from "$lib/server/db/db.js";
import { invalidateOrgDomainCache } from "$lib/server/http/orgResolve.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * G4. Chooses which of a page's domains its absolute URLs use.
 *
 * Promoting and demoting is one repository call because "primary" is a property
 * of the set: promoting alone would leave two rows claiming it.
 */
export default {
  action: "setPrimaryPageDomain",
  handler: async (data: LegacyPayload) => {
    const id = Number((data as { id?: number }).id);
    if (!Number.isFinite(id)) throw new Error("id is required");

    const existing = await db.getPageDomainById(id);
    if (!existing) throw new Error("Domain not found");

    await db.setPrimaryPageDomain(existing.page_id, id);
    invalidateOrgDomainCache();
    return { id };
  },
} satisfies ActionDefinition<LegacyPayload>;
