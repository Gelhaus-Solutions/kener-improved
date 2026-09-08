import db from "$lib/server/db/db";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "deleteImage",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await db.deleteImage(data.id);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
