import { AddUserToRole } from "$lib/server/controllers/userController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "addUserToRole",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await AddUserToRole(data.roleId, data.userId);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
