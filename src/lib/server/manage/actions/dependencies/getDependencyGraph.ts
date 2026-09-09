import db from "$lib/server/db/db.js";
import type { ActionDefinition } from "../../types.js";

/**
 * The whole graph, for the read-only view.
 *
 * Monitor names come along because the graph is read by a person, and a screen
 * of tags is a screen nobody uses. Sent as one map rather than joined per edge so
 * the payload does not repeat a name once per edge it appears in.
 */
export default {
  action: "getDependencyGraph",
  handler: async () => {
    const [edges, settings, monitors] = await Promise.all([
      db.getAllDependencies(),
      db.getAllRollupSettings(),
      db.getMonitors({}),
    ]);
    const names: Record<string, string> = {};
    for (const monitor of monitors) names[monitor.tag] = monitor.name;
    return { edges, settings, names };
  },
} satisfies ActionDefinition;
