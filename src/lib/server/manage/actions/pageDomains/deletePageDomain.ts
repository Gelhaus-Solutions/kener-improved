import db from "$lib/server/db/db.js";
import { invalidateOrgDomainCache } from "$lib/server/http/orgResolve.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/** G4. Removes a custom domain. Scoped, so another org's id is simply not found. */
export default {
  action: "deletePageDomain",
  handler: async (data: LegacyPayload) => {
    const id = Number((data as { id?: number }).id);
    if (!Number.isFinite(id)) throw new Error("id is required");

    const existing = await db.getPageDomainById(id);
    if (!existing) throw new Error("Domain not found");

    await db.deletePageDomain(id);
    invalidateOrgDomainCache();
    return { deleted: true };
  },
} satisfies ActionDefinition<LegacyPayload>;
