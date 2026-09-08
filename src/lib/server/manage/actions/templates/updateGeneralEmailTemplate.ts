import { UpdateGeneralEmailTemplate } from "$lib/server/controllers/generalTemplateController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateGeneralEmailTemplate",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const { templateId, template_subject, template_html_body, template_text_body } = data;
    if (!templateId) {
      throw new Error("Template ID is required");
    }
    resp = await UpdateGeneralEmailTemplate(templateId, {
      template_subject,
      template_html_body,
      template_text_body,
    });
    if (!resp.success) {
      throw new Error(resp.error);
    }
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
