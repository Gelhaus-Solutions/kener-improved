import { RotateWebhookEndpointSecret } from "$lib/server/controllers/webhookController.js";
import type { ActionDefinition } from "../../types.js";

/** Returns the new secret once. No snapshot, for the reason in createWebhookEndpoint. */
export default {
  action: "rotateWebhookEndpointSecret",
  audit: { targetType: "webhook_endpoint" },
  handler: async (data: { id: number }) => await RotateWebhookEndpointSecret(Number(data.id)),
} satisfies ActionDefinition<{ id: number }>;
