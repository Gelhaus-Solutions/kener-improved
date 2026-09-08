import { CreateNewAPIKey } from "$lib/server/controllers/controller.js";
import type { ActionContext, ActionDefinition } from "../../types.js";

interface CreateApiKeyPayload {
  name: string;
  scopes?: string[];
  expires_in_days?: number;
}

/**
 * Mints an API key, capped at the caller's own permissions.
 *
 * The caller is passed down rather than the controller reaching for a session,
 * because the ceiling check is the whole point and it has to run against the
 * permission set the pipeline already resolved for this request. Omitting the
 * caller is what non-HTTP callers (seeds, scripts) do, and it produces the
 * pre-scoping behaviour: a full-access key, no ceiling.
 */
export default {
  action: "createNewApiKey",
  audit: { targetType: "api_key" },
  handler: async (data: CreateApiKeyPayload, ctx: ActionContext) => {
    return await CreateNewAPIKey(data, { userId: ctx.user.id, permissions: ctx.permissions });
  },
} satisfies ActionDefinition<CreateApiKeyPayload>;
