import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  name?: string;
}

/**
 * Empties a category, leaving its monitors uncategorised.
 *
 * **Deletes no monitors**, which is worth being explicit about: a category is
 * only a value on the monitors that hold it, so "delete" here can only mean
 * clearing that value. Those monitors keep every other setting and move into the
 * "Other" section on any page grouped by category.
 */
export default {
  action: "deleteCategory",
  audit: { targetType: "monitor" },
  handler: async (data: Payload) => {
    const name = String(data.name ?? "").trim();
    if (!name) throw new ActionError(400, "A category name is required");

    const cleared = await db.recategoriseMonitors(name, null);
    if (cleared === 0) throw new ActionError(404, `No monitors are in "${name}"`);
    return { success: true, cleared };
  },
} satisfies ActionDefinition<Payload>;
