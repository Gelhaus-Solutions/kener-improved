import db from "$lib/server/db/db.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/** G4. The custom domains bound to one page. Org-scoped by the repository. */
export default {
  action: "getPageDomains",
  handler: async (data: LegacyPayload) => {
    const pageId = Number((data as { page_id?: number }).page_id);
    if (!Number.isFinite(pageId)) throw new Error("page_id is required");
    return await db.getPageDomains(pageId);
  },
} satisfies ActionDefinition<LegacyPayload>;
