import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  id?: number;
  name?: string;
  region_id?: number;
  status?: string;
}

/**
 * B1c. Renames an agent, moves it between regions, or switches it off.
 *
 * **Disabling does not close the connection, and that is on purpose.** `status`
 * is what an operator wants; `connection_state` is what is true. A disabled
 * agent stops being offered work by `getProbeTargetsForMonitor`, which filters
 * on ACTIVE, so from the next tick its monitors are checked locally - the
 * fallback, reached the ordinary way. Killing the socket as well would add a
 * second mechanism for the same outcome and a reconnect loop to go with it,
 * since a disabled agent's daemon has no way of knowing it should stop trying.
 *
 * Moving an agent to a region that already has one is refused for the same
 * reason creating a second one is: the registry serves one per region, so the
 * loser would authenticate and immediately be closed.
 */
export default {
  action: "updateProbeAgent",
  audit: { targetType: "probe_agent" },
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isFinite(id)) throw new ActionError(400, "id is required");

    const agent = await db.getProbeAgentById(id);
    if (!agent) throw new ActionError(404, "That probe agent does not exist");

    const patch: { name?: string; region_id?: number; status?: string } = {};

    if (data.name !== undefined) {
      const name = String(data.name).trim();
      if (!name) throw new ActionError(400, "A name is required");
      patch.name = name;
    }

    if (data.region_id !== undefined) {
      const regionId = Number(data.region_id);
      if (!Number.isInteger(regionId) || regionId < 0) throw new ActionError(400, "That is not a region");
      // No check that the region is free: a region may be served by any number
      // of agents, which are replicas reduced to one verdict before the merge.
      patch.region_id = regionId;
    }

    if (data.status !== undefined) {
      const status = String(data.status).toUpperCase();
      if (status !== "ACTIVE" && status !== "DISABLED") {
        throw new ActionError(400, "Status must be ACTIVE or DISABLED");
      }
      patch.status = status;
    }

    if (Object.keys(patch).length === 0) return { updated: 0 };

    const updated = await db.updateProbeAgent(id, patch);
    return { updated };
  },
} satisfies ActionDefinition<Payload>;
