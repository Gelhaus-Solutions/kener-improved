import { GetUserByIDDashboard, ManualUpdateUserData } from "$lib/server/controllers/controller.js";
import type { ActionContext, ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain.
 *
 * The only change is that the caller is now passed through (KENER-31). The
 * org-owner guards inside `ManualUpdateUserData` are overridable by the instance
 * superadmin, and the controller cannot know who is acting without being told.
 */
export default {
  action: "manualUpdate",
  // Before/after on this one: it is a config change people ask questions about later.
  audit: {
    targetType: "user",
    snapshot: async (data) => (data.id ? await GetUserByIDDashboard(Number(data.id)) : undefined),
  },
  handler: async (data: LegacyPayload, ctx: ActionContext) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    await ManualUpdateUserData(data.id, data, ctx.user);
    resp = await GetUserByIDDashboard(data.id);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
