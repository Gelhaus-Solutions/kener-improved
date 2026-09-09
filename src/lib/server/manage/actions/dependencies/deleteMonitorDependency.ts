import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  parent_monitor_tag: string;
  child_monitor_tag: string;
  relation?: string;
}

export default {
  action: "deleteMonitorDependency",
  permission: "monitors.write",
  audit: { targetType: "component_dependency" },
  handler: async (data: Payload) => {
    const parent = String(data.parent_monitor_tag ?? "");
    const child = String(data.child_monitor_tag ?? "");
    if (!parent || !child) throw new ActionError(400, "Both a parent and a child monitor are required");
    const removed = await db.deleteDependency(parent, child, String(data.relation ?? "CONTAINS"));
    return { success: true, removed };
  },
} satisfies ActionDefinition<Payload>;
