import { UpdateUserData } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateUser",
  handler: async (data: LegacyPayload, ctx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    data.userID = ctx.user.id;
    resp = await UpdateUserData(data);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
