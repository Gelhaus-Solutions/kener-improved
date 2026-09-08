import { UpdateRole } from "$lib/server/controllers/userController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateRole",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await UpdateRole(data.roleId, { name: data.name, status: data.status });
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
