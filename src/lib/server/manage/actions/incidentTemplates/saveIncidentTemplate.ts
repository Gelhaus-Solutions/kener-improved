import db from "$lib/server/db/db.js";
import { GetTemplate, parseComponents, parseVariables } from "$lib/server/incidents/templates.js";
import { isIncidentSeverity } from "$lib/server/incidents/impact.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";
import type { IncidentTemplateInput } from "$lib/server/types/incidentTemplate.js";

interface Payload extends IncidentTemplateInput {
  id?: number | string;
}

const STATES = ["INVESTIGATING", "IDENTIFIED", "MONITORING", "RESOLVED"];

/**
 * Creates or edits a template.
 *
 * `usage_count` is deliberately not settable. It is evidence about what people
 * reach for, and a field an operator can type into is a field that stops being
 * evidence.
 */
export default {
  action: "saveIncidentTemplate",
  audit: {
    targetType: "incident_template",
    snapshot: async (data) => (data.id ? await GetTemplate(Number(data.id)) : undefined),
  },
  handler: async (data: Payload) => {
    const name = data.name?.trim();
    if (!name) throw new ActionError(400, "A template needs a name");
    if (!data.title_template?.trim()) throw new ActionError(400, "A template needs a title");

    if (data.default_severity && !isIncidentSeverity(data.default_severity)) {
      throw new ActionError(400, "default_severity is not a recognised value");
    }
    if (data.default_state && !STATES.includes(data.default_state)) {
      throw new ActionError(400, `default_state must be one of: ${STATES.join(", ")}`);
    }

    const fields = {
      name,
      description: data.description ?? null,
      title_template: data.title_template.trim(),
      body_template: data.body_template ?? null,
      // Empty string means "the template says nothing about this", which is a
      // different instruction from an explicit NONE and must not become one.
      default_severity: data.default_severity || null,
      default_state: data.default_state || null,
      default_components: JSON.stringify(parseComponents(data.default_components)),
      variables: JSON.stringify(parseVariables(data.variables)),
      is_global: data.is_global === "NO" ? "NO" : "YES",
    };

    const id = data.id ? Number(data.id) : null;

    // Checked here rather than left to the UNIQUE, so the operator gets a
    // sentence instead of a constraint violation. The UNIQUE still stands as the
    // thing that is actually true.
    const clash = await db.getIncidentTemplateByName(name);
    if (clash && clash.id !== id) {
      throw new ActionError(400, `A template named "${name}" already exists`);
    }

    if (id) {
      const existing = await db.getIncidentTemplateById(id);
      if (!existing) throw new ActionError(404, "Template not found");
      await db.updateIncidentTemplate(id, fields);
      return await GetTemplate(id);
    }

    const row = await db.insertIncidentTemplate({ ...fields, usage_count: 0 });
    return await GetTemplate(row.id);
  },
} satisfies ActionDefinition<Payload>;
