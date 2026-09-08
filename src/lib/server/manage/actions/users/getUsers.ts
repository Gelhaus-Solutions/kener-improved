import { GetAllUsersPaginatedDashboard, GetUsersCount } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getUsers",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const page = parseInt(String(data.page)) || 1;
    const limit = parseInt(String(data.limit)) || 10;
    const filter: { is_active?: number } = {};
    if (data.is_active !== undefined && data.is_active !== null) {
      filter.is_active = parseInt(String(data.is_active));
    }
    const hasFilter = Object.keys(filter).length > 0 ? filter : undefined;
    const users = await GetAllUsersPaginatedDashboard({ page, limit }, hasFilter);
    const totalResult = await GetUsersCount(hasFilter);
    const total = totalResult ? Number(totalResult.count) : 0;
    resp = { users, total };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
