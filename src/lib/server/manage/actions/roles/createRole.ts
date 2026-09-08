import { CreateRole } from "$lib/server/controllers/userController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "createRole",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await CreateRole({ role_id: data.role_id, name: data.name });
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
