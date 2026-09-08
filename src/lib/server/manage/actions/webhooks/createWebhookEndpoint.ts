import { CreateWebhookEndpoint, type CreateWebhookInput } from "$lib/server/controllers/webhookController.js";
import type { ActionDefinition } from "../../types.js";

/**
 * The response carries the signing secret. It is the only time it is ever
 * returned, which is why this action has no snapshot: an audit before/after over
 * a payload containing a fresh secret would write it to the audit log, and the
 * whole point of encrypting the column is that it exists in exactly one place.
 */
export default {
  action: "createWebhookEndpoint",
  audit: { targetType: "webhook_endpoint" },
  handler: async (data: CreateWebhookInput) => await CreateWebhookEndpoint(data),
} satisfies ActionDefinition<CreateWebhookInput>;
