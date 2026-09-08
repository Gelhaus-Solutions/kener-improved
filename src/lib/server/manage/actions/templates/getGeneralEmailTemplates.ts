import { GetAllGeneralEmailTemplates } from "$lib/server/controllers/generalTemplateController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getGeneralEmailTemplates",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await GetAllGeneralEmailTemplates();
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
