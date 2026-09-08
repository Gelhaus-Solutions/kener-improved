import { GetUserByIDDashboard, ManualUpdateUserData } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "manualUpdate",
  // Before/after on this one: it is a config change people ask questions about later.
  audit: { targetType: "user", snapshot: async (data) => (data.id ? await GetUserByIDDashboard(Number(data.id)) : undefined) },
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    await ManualUpdateUserData(data.id, data);
    resp = await GetUserByIDDashboard(data.id);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
