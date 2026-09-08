import { UpdateCommentStatusByID } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "deleteComment",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await UpdateCommentStatusByID(data.incident_id, data.comment_id, "INACTIVE");
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
