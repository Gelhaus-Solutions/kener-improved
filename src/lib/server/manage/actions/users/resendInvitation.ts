import { ResendInvitationEmail } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "resendInvitation",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    await ResendInvitationEmail(data.email);
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
