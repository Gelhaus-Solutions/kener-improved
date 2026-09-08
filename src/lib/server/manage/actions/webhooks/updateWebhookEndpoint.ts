import { UpdateWebhookEndpoint, type UpdateWebhookInput } from "$lib/server/controllers/webhookController.js";
import { GetWebhookEndpoint } from "$lib/server/controllers/webhookController.js";
import type { ActionDefinition } from "../../types.js";

export default {
  action: "updateWebhookEndpoint",
  audit: {
    targetType: "webhook_endpoint",
    // Safe to snapshot: the view type omits both secret columns by construction.
    snapshot: async (data) => (data.id ? await GetWebhookEndpoint(Number(data.id)).catch(() => undefined) : undefined),
  },
  handler: async (data: UpdateWebhookInput) => await UpdateWebhookEndpoint(data),
} satisfies ActionDefinition<UpdateWebhookInput>;
