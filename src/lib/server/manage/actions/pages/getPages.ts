import { GetAllPages, GetPageMonitors } from "$lib/server/controllers/pagesController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getPages",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const pages = await GetAllPages();
    // Fetch monitors for each page
    const pagesWithMonitors = await Promise.all(
      pages.map(async (page) => {
        const monitors = await GetPageMonitors(page.id);
        return { ...page, monitors };
      }),
    );
    resp = pagesWithMonitors;
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
