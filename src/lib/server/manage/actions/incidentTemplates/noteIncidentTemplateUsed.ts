import { NoteTemplateUsed } from "$lib/server/incidents/templates.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  id?: number | string;
}

/**
 * Records that a template was actually used to open an incident.
 *
 * Separate from applying it, because applying happens on every keystroke of the
 * preview and using happens once. Counting previews would sort the template list
 * by who fiddled with what rather than by what gets reached for during an
 * outage, which is the only thing the count is for.
 */
export default {
  action: "noteIncidentTemplateUsed",
  audit: false,
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isInteger(id) || id <= 0) throw new ActionError(400, "A template id is required");
    await NoteTemplateUsed(id);
    return { success: true };
  },
} satisfies ActionDefinition<Payload>;
