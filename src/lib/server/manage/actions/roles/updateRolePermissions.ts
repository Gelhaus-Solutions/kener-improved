import { GetRolePermissions } from "$lib/server/controllers/userController.js";
import { UpdateRolePermissions } from "$lib/server/controllers/userController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateRolePermissions",
  // Before/after on this one: it is a config change people ask questions about later.
  audit: { targetType: "role", snapshot: async (data) => (data.role_id ? await GetRolePermissions(String(data.role_id)) : undefined) },
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await UpdateRolePermissions(data.roleId, data.permissionIds);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
