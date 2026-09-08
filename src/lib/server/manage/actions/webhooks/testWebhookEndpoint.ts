import { TestWebhookEndpoint } from "$lib/server/controllers/webhookController.js";
import type { ActionDefinition } from "../../types.js";

export default {
  action: "testWebhookEndpoint",
  audit: { targetType: "webhook_endpoint" },
  handler: async (data: { id: number }) => await TestWebhookEndpoint(Number(data.id)),
} satisfies ActionDefinition<{ id: number }>;
