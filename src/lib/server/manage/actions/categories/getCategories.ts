import db from "$lib/server/db/db.js";
import type { ActionDefinition } from "../../types.js";
import type { MonitorRecord } from "$lib/server/types/db.js";

/**
 * Every category in this org, with the monitors in it.
 *
 * **A category is not a row anywhere.** It is a distinct value of
 * `monitors.category_name`, which is what the public page already groups by, so
 * this reads the monitors and groups them rather than reading a catalogue. A
 * `categories` table would be a second source of truth for a thing the renderer
 * derives, and the first thing it would disagree about is ordering.
 *
 * Uncategorised monitors come back under a `null` name and always last, which is
 * where the public page puts them too - `pages/[page_id]` calls that section
 * "Other".
 */
export default {
  action: "getCategories",
  handler: async () => {
    const monitors = await db.getMonitors({});

    const byCategory = new Map<string | null, MonitorRecord[]>();
    for (const monitor of monitors) {
      // Trimmed and emptied to null here rather than in the component, so "   "
      // and "" and null are one case by the time anything renders them. The same
      // normalisation `dashboardController` applies.
      const name = (monitor.category_name ?? "").trim();
      const key = name.length > 0 ? name : null;
      const list = byCategory.get(key) ?? [];
      list.push(monitor);
      byCategory.set(key, list);
    }

    const named = [...byCategory.keys()]
      .filter((name): name is string => name !== null)
      .sort((a, b) => a.localeCompare(b));

    const shape = (name: string | null) => ({
      name,
      monitors: (byCategory.get(name) ?? [])
        .map((monitor) => ({
          tag: monitor.tag,
          // The public link carries the per-org slug, never the prefixed tag.
          slug: monitor.slug || monitor.tag,
          name: monitor.name,
          status: monitor.status,
          is_hidden: monitor.is_hidden,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });

    return {
      categories: named.map(shape),
      // Present even when empty, so the screen can say "everything is in a
      // category" rather than silently omitting the bucket.
      uncategorised: shape(null),
    };
  },
} satisfies ActionDefinition;
