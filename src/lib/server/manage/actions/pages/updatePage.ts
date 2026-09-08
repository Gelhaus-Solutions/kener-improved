import { UpdatePage } from "$lib/server/controllers/pagesController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updatePage",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const { id, ...updateData } = data;
    resp = await UpdatePage(id, updateData);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
