import db from "$lib/server/db/db.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  monitor_tag: string;
}

/** One monitor's dependency edges, both directions, plus its rollup setting. */
export default {
  action: "getMonitorDependencies",
  handler: async (data: Payload) => {
    const tag = String(data.monitor_tag ?? "");
    if (!tag) return { children: [], parents: [], setting: null };
    const [edges, setting] = await Promise.all([db.getDependenciesForMonitor(tag), db.getRollupSetting(tag)]);
    return { ...edges, setting: setting ?? null };
  },
} satisfies ActionDefinition<Payload>;
