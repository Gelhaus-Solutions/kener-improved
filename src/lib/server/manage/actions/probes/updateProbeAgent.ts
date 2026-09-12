import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";
import { parseWeight } from "./createProbeAgent.js";

interface Payload {
  id?: number;
  name?: string;
  region_id?: number;
  /** B1g. This agent's say among the others in its region. */
  weight?: number;
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
 * Moving an agent into a region that already has agents is allowed, for the same
 * reason creating a second one there is: they answer for one vantage point, all
 * dispatched, and reduced to that region's single verdict before the merge sees
 * them. What moving an agent changes is what its results *mean*, never where it
 * runs.
 *
 * B1g. `weight` changes how much that agent counts in its region's own
 * reduction. It is not a way to give a region more say: the region still casts
 * exactly one vote whatever its agents weigh.
 */
export default {
  action: "updateProbeAgent",
  audit: { targetType: "probe_agent" },
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isFinite(id)) throw new ActionError(400, "id is required");

    const agent = await db.getProbeAgentById(id);
    if (!agent) throw new ActionError(404, "That probe agent does not exist");

    const patch: { name?: string; region_id?: number; weight?: number; status?: string } = {};

    if (data.name !== undefined) {
      const name = String(data.name).trim();
      if (!name) throw new ActionError(400, "A name is required");
      patch.name = name;
    }

    if (data.region_id !== undefined) {
      const regionId = Number(data.region_id);
      if (!Number.isInteger(regionId) || regionId < 0) throw new ActionError(400, "That is not a region");
      // No check that the region is free: a region may be served by any number
      // of agents, whose answers are reduced to one verdict before the merge.
      patch.region_id = regionId;
    }

    if (data.weight !== undefined) {
      patch.weight = parseWeight(data.weight);
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
