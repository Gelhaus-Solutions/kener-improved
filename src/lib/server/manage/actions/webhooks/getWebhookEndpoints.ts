import { GetWebhookEndpoints } from "$lib/server/controllers/webhookController.js";
import type { ActionDefinition } from "../../types.js";

export default {
  action: "getWebhookEndpoints",
  handler: async () => await GetWebhookEndpoints(),
} satisfies ActionDefinition<Record<string, never>>;
