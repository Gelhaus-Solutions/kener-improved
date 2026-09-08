import { RotateApiKey } from "$lib/server/controllers/controller.js";
import type { ActionContext, ActionDefinition } from "../../types.js";

interface RotateApiKeyPayload {
  id: number;
  /** Optional narrowing. Omitted carries the existing scopes forward unchanged. */
  scopes?: string[];
}

/**
 * Replaces a key's secret without breaking whatever is using it.
 *
 * Goes through the same ceiling check a fresh mint does. Without that, rotation
 * would be the way around it: rotate somebody else's full-access key and inherit
 * scopes you could never have been granted.
 */
export default {
  action: "rotateApiKey",
  audit: { targetType: "api_key" },
  handler: async (data: RotateApiKeyPayload, ctx: ActionContext) => {
    return await RotateApiKey(data, { userId: ctx.user.id, permissions: ctx.permissions });
  },
} satisfies ActionDefinition<RotateApiKeyPayload>;
