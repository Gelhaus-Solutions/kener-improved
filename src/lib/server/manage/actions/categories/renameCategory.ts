import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  from?: string;
  to?: string;
}

/**
 * Renames a category across every monitor that holds it.
 *
 * **Merging is allowed and is not an error.** Renaming "API" to an existing
 * "Platform" moves those monitors into it, which is the only sensible reading of
 * the request and the only way to combine two sections without editing every
 * monitor by hand. The screen says so before it asks.
 */
export default {
  action: "renameCategory",
  audit: { targetType: "monitor" },
  handler: async (data: Payload) => {
    const from = String(data.from ?? "").trim();
    const to = String(data.to ?? "").trim();
    if (!from) throw new ActionError(400, "The category being renamed is required");
    if (!to) throw new ActionError(400, "A new name is required. To clear a category, delete it instead");
    if (from === to) return { success: true, moved: 0 };

    const moved = await db.recategoriseMonitors(from, to);
    if (moved === 0) throw new ActionError(404, `No monitors are in "${from}"`);
    return { success: true, moved };
  },
} satisfies ActionDefinition<Payload>;
