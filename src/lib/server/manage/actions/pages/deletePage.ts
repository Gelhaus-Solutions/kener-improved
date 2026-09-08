import { DeletePage } from "$lib/server/controllers/pagesController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "deletePage",
  audit: { targetType: "page" },
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    await DeletePage(data.id);
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
