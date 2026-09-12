import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  tag?: string;
  category?: string | null;
}

/**
 * Moves one monitor into a category, or out of every category.
 *
 * An empty or whitespace-only category means uncategorised, stored as `null`.
 * Accepting `""` would create a nameless section in the grouping that no screen
 * could select and no visitor could read.
 */
export default {
  action: "setMonitorCategory",
  audit: { targetType: "monitor" },
  handler: async (data: Payload) => {
    const tag = String(data.tag ?? "").trim();
    if (!tag) throw new ActionError(400, "A monitor tag is required");

    const monitor = await db.getMonitorByTag(tag);
    if (!monitor) throw new ActionError(404, "That monitor does not exist");

    const category = String(data.category ?? "").trim();
    await db.setMonitorCategory(tag, category.length > 0 ? category : null);
    return { success: true, tag, category: category.length > 0 ? category : null };
  },
} satisfies ActionDefinition<Payload>;
