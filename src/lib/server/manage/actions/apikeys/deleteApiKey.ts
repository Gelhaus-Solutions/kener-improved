import { DeleteApiKey } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "deleteApiKey",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const deleted = await DeleteApiKey(data);
    if (!deleted) {
      throw new Error("API key not found");
    }
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
