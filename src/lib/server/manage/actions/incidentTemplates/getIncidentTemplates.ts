import { ListTemplates } from "$lib/server/incidents/templates.js";
import type { ActionDefinition } from "../../types.js";

/** Every template in the org, most-used first. */
export default {
  action: "getIncidentTemplates",
  handler: async () => await ListTemplates(),
} satisfies ActionDefinition<Record<string, never>>;
