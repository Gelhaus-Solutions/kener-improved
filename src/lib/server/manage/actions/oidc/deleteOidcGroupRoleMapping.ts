import db from "$lib/server/db/db";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "deleteOidcGroupRoleMapping",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const mappingId = Number(data.id);
    if (!Number.isInteger(mappingId) || mappingId <= 0) {
      throw new Error("Mapping ID is required");
    }
    await db.deleteOidcGroupRoleMapping(mappingId);
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
