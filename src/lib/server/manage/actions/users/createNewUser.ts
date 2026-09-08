import { GetUserByEmail, SendInvitationEmail } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "createNewUser",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    await SendInvitationEmail(data.email, data.role_ids, data.name);
    resp = await GetUserByEmail(data.email);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
