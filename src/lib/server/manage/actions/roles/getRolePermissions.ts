import { GetRolePermissions } from "$lib/server/controllers/userController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getRolePermissions",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await GetRolePermissions(data.roleId);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
