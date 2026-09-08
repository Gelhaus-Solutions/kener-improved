import { DeleteTrigger } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "deleteTrigger",
  audit: { targetType: "trigger" },
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await DeleteTrigger(data.trigger_id);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
