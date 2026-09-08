import { AddMonitorToPage } from "$lib/server/controllers/pagesController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "addMonitorToPage",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    await AddMonitorToPage(data.page_id, data.monitor_tag);
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
