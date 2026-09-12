import db from "$lib/server/db/db.js";
import GC from "$lib/global-constants.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  monitor_tag?: string;
  agent_id?: number;
}

/**
 * B1c. Hands one monitor to one probe agent.
 *
 * **Eligibility is refused here, not silently ignored later.** The scheduler
 * checks `PROBE_ELIGIBLE_TYPES` before dispatching anything, so assigning a
 * GROUP or SQL monitor would be accepted by the database and then quietly do
 * nothing forever. The reason is worth stating to whoever is looking at the
 * form: those types need something of Kener's - Redis, the database, a
 * connection Kener holds - and no amount of network access lets a probe supply
 * it.
 *
 * Assigning the same monitor to several *different* agents is allowed and is
 * what multi-region checking is. Assigning it twice to the same agent is the
 * unique constraint's job, caught here first so the operator gets a sentence
 * rather than a driver error.
 */
export default {
  action: "assignMonitorToProbe",
  audit: { targetType: "probe_agent" },
  handler: async (data: Payload) => {
    const monitorTag = String(data.monitor_tag ?? "").trim();
    if (!monitorTag) throw new ActionError(400, "monitor_tag is required");

    const agentId = Number(data.agent_id);
    if (!Number.isFinite(agentId)) throw new ActionError(400, "agent_id is required");

    const agent = await db.getProbeAgentById(agentId);
    if (!agent) throw new ActionError(404, "That probe agent does not exist");

    // Scoped, so a tag belonging to another org simply is not found.
    const monitor = await db.getMonitorsByTag(monitorTag);
    if (!monitor) throw new ActionError(404, "That monitor does not exist");

    if (!(GC.PROBE_ELIGIBLE_TYPES as readonly string[]).includes(monitor.monitor_type)) {
      throw new ActionError(
        400,
        `A ${monitor.monitor_type} monitor cannot run on a probe: it needs something only Kener has. Remote checks are limited to ${GC.PROBE_ELIGIBLE_TYPES.join(", ")}.`,
      );
    }

    if (await db.probeAssignmentExists(monitorTag, agentId)) {
      throw new ActionError(409, "That monitor is already assigned to this agent");
    }

    const id = await db.createProbeAssignment({ monitor_tag: monitorTag, agent_id: agentId });
    return { id };
  },
} satisfies ActionDefinition<Payload>;
