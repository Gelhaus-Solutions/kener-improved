import { RevokeApiKey } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Burns a key for good.
 *
 * Deliberately not `deleteApiKey`: deleting the row loses the record that the
 * key ever existed, which is exactly what an incident review needs. Revoking
 * keeps the row, its name, and its last-used timestamp, and guarantees it never
 * authenticates again. It also needs only `api_keys.write`, so cutting a
 * rotation's grace window short does not require the delete permission.
 */
export default {
  action: "revokeApiKey",
  audit: { targetType: "api_key" },
  handler: async (data: LegacyPayload) => {
    const revoked = await RevokeApiKey(data);
    if (!revoked) {
      throw new Error("API key not found, or already revoked");
    }
    return { success: true };
  },
} satisfies ActionDefinition<LegacyPayload>;
