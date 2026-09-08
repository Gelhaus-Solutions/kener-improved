import { UpdateCommentByID } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateComment",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await UpdateCommentByID(data.incident_id, data.comment_id, data.comment, data.state, data.commented_at);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
