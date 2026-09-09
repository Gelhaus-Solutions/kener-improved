import { ApplyTemplate } from "$lib/server/incidents/templates.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  id?: number | string;
  values?: Record<string, string>;
}

/**
 * Renders a template into what an incident would be. **Creates nothing.**
 *
 * A read in every sense that matters - it writes no row and it is called on
 * every keystroke of the preview - so it maps to `incidents.read` and is not
 * audited. The incident it eventually produces is audited by `createIncident`,
 * which is the action that actually happens.
 */
export default {
  action: "applyIncidentTemplate",
  audit: false,
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isInteger(id) || id <= 0) throw new ActionError(400, "A template id is required");
    try {
      return await ApplyTemplate(id, data.values ?? {});
    } catch (e) {
      throw new ActionError(404, e instanceof Error ? e.message : "Could not apply the template");
    }
  },
} satisfies ActionDefinition<Payload>;
