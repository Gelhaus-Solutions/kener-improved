import db from "$lib/server/db/db.js";
import { GetTemplate } from "$lib/server/incidents/templates.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  id?: number | string;
}

/**
 * Removes a template.
 *
 * Incidents opened from it keep their `template_id`, which is why C2 gave that
 * column no foreign key: a template deleted later must not take its incidents
 * with it, and the id remains a true statement about where the text came from.
 */
export default {
  action: "deleteIncidentTemplate",
  audit: {
    targetType: "incident_template",
    snapshot: async (data) => (data.id ? await GetTemplate(Number(data.id)) : undefined),
  },
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isInteger(id) || id <= 0) throw new ActionError(400, "A template id is required");
    const removed = await db.deleteIncidentTemplate(id);
    if (removed === 0) throw new ActionError(404, "Template not found");
    return { success: true };
  },
} satisfies ActionDefinition<Payload>;
