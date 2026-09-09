import db from "$lib/server/db/db.js";
import { wouldCreateCycle } from "$lib/server/incidents/rollup.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  parent_monitor_tag: string;
  child_monitor_tag: string;
  relation?: string;
  propagation?: string;
  weight?: number;
}

const RELATIONS = ["CONTAINS", "DEPENDS_ON"];
const PROPAGATIONS = ["WORST", "WEIGHTED", "NONE"];

/**
 * Adds or edits one dependency edge.
 *
 * **The cycle check happens here, on the way in.** A loop makes the rollup
 * non-terminating in principle and merely wrong in practice - the depth limit
 * stops it - but either way the operator who typed it should be told while they
 * are looking at the form, not left to find a component reporting nonsense a
 * week later. Read-time defence alone would be the second thing.
 */
export default {
  action: "setMonitorDependency",
  permission: "monitors.write",
  audit: { targetType: "component_dependency" },
  handler: async (data: Payload) => {
    const parent = String(data.parent_monitor_tag ?? "");
    const child = String(data.child_monitor_tag ?? "");
    if (!parent || !child) throw new ActionError(400, "Both a parent and a child monitor are required");

    const relation = String(data.relation ?? "CONTAINS");
    const propagation = String(data.propagation ?? "WORST");
    if (!RELATIONS.includes(relation)) throw new ActionError(400, `relation must be one of ${RELATIONS.join(", ")}`);
    if (!PROPAGATIONS.includes(propagation)) {
      throw new ActionError(400, `propagation must be one of ${PROPAGATIONS.join(", ")}`);
    }

    for (const tag of [parent, child]) {
      if (!(await db.getMonitorByTag(tag))) throw new ActionError(400, `Monitor "${tag}" does not exist`);
    }

    const existing = await db.getAllDependencies();
    if (wouldCreateCycle(existing, parent, child)) {
      throw new ActionError(
        400,
        parent === child
          ? "A component cannot depend on itself"
          : `"${child}" already depends on "${parent}", so this would make a loop`,
      );
    }

    const weight = Number.isFinite(Number(data.weight)) && Number(data.weight) > 0 ? Number(data.weight) : 1;
    await db.insertDependency({
      parent_monitor_tag: parent,
      child_monitor_tag: child,
      relation,
      propagation,
      weight,
    });
    return { success: true };
  },
} satisfies ActionDefinition<Payload>;
