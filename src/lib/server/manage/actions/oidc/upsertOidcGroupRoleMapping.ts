import db from "$lib/server/db/db";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "upsertOidcGroupRoleMapping",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    if (!data.oidc_group || typeof data.oidc_group !== "string" || !data.oidc_group.trim()) {
      throw new Error("OIDC group name is required");
    }
    if (!data.role_id || typeof data.role_id !== "string") {
      throw new Error("Role ID is required");
    }
    const role = await db.getRoleById(data.role_id);
    if (!role) {
      throw new Error(`Role "${data.role_id}" not found`);
    }
    await db.upsertOidcGroupRoleMapping({
      oidc_group: data.oidc_group.trim(),
      role_id: data.role_id,
    });
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
