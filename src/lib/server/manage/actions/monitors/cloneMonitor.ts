import { CloneMonitor } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "cloneMonitor",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await CloneMonitor({
      sourceTag: String(data.sourceTag || ""),
      newTag: String(data.newTag || ""),
      newName: String(data.newName || ""),
    });
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
