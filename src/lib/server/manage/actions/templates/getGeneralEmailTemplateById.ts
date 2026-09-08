import { GetGeneralEmailTemplateById } from "$lib/server/controllers/generalTemplateController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getGeneralEmailTemplateById",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const { templateId } = data;
    if (!templateId) {
      throw new Error("Template ID is required");
    }
    resp = await GetGeneralEmailTemplateById(templateId);
    if (!resp) {
      throw new Error("Template not found");
    }
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
