import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  id?: number;
}

/**
 * B1c. Removes an agent and everything assigned to it.
 *
 * The assignments go with it, in the repository, because the schema carries no
 * foreign key: an orphaned assignment would point at an id the `increments`
 * sequence could later hand to a completely different agent, which would
 * silently re-assign somebody's monitors to a new probe.
 *
 * A connected agent's socket is left to die on its own. Its next frame finds no
 * row behind it and the connection is dropped; anything it had already been
 * assigned either arrives first or times out into a local check. Reaching into
 * the registry from here would mean the web process trying to close a socket
 * that, in development, belongs to a different process entirely.
 */
export default {
  action: "deleteProbeAgent",
  audit: { targetType: "probe_agent" },
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isFinite(id)) throw new ActionError(400, "id is required");

    const deleted = await db.deleteProbeAgent(id);
    if (deleted === 0) throw new ActionError(404, "That probe agent does not exist");
    return { deleted: true };
  },
} satisfies ActionDefinition<Payload>;
