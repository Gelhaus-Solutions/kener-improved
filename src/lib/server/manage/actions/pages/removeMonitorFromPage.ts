import { RemoveMonitorFromPage } from "$lib/server/controllers/pagesController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "removeMonitorFromPage",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    await RemoveMonitorFromPage(data.page_id, data.monitor_tag);
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
