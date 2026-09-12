import db from "$lib/server/db/db.js";
import GC from "$lib/global-constants.js";
import { MERGED_REGION_ID } from "$lib/server/db/regions.js";
import { getConnection } from "$lib/server/probes/registry.js";
import { configuredPort } from "$lib/server/probes/wsServer.js";
import type { ActionDefinition } from "../../types.js";

/**
 * B1c. Everything the probes screen draws, in one call.
 *
 * **`connected` is read from the registry, not from the column.**
 * `probe_agents.connection_state` is written by the WS server as connections
 * come and go, but the screen is served by the *web* process and in development
 * that is a different process from the scheduler entirely. The column is the
 * durable record and is right within a heartbeat; `live` says whether this
 * process can see the socket, and is null when it cannot possibly know.
 *
 * `ws_enabled` exists so the screen can say the one thing that makes every other
 * field meaningless: with `KENER_PROBE_WS_PORT` unset there is no listener, so
 * no agent can ever connect however correctly it is configured.
 */
export default {
  action: "getProbeFleet",
  handler: async () => {
    const [agents, assignments, regions, monitors] = await Promise.all([
      db.getProbeAgents(),
      db.getProbeAssignments(),
      db.getAssignableRegions(),
      db.getMonitors({ status: "ACTIVE" }),
    ]);

    // The web process only holds probe connections when it is also the scheduler,
    // which is production's single process but never development's split one.
    // Saying "not connected" there would be a lie about something this process
    // cannot observe, so it says nothing instead.
    const wsPort = configuredPort();
    const canSeeConnections = wsPort !== null;

    return {
      ws_enabled: canSeeConnections,
      ws_port: wsPort,
      eligible_types: GC.PROBE_ELIGIBLE_TYPES,
      merged_region_id: MERGED_REGION_ID,
      regions: [
        {
          id: MERGED_REGION_ID,
          code: "merged",
          name: "Merged verdict",
          is_active: true,
          // Said here rather than in the component so the explanation lives with
          // the one fact that makes region 0 different from every other choice.
          note: "An agent here replaces the local check and produces the authoritative status.",
        },
        ...regions
          .filter((region) => region.id !== MERGED_REGION_ID)
          .map((region) => ({ ...region, note: "An agent here adds a regional sample alongside the local check." })),
      ],
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        region_id: agent.region_id,
        status: agent.status,
        connection_state: agent.connection_state,
        live: canSeeConnections ? !!getConnection(agent.id) : null,
        token_hint: agent.token_hint,
        agent_version: agent.agent_version,
        capabilities: parseCapabilities(agent.capabilities),
        last_seen_at: agent.last_seen_at,
      })),
      assignments,
      monitors: monitors
        // Only the types a probe could ever run. Offering the rest would invite
        // an operator to assign a GROUP monitor and then wonder why nothing
        // happened: the scheduler would refuse it silently, because the
        // eligibility check is the thing standing between a probe and a check
        // that needs the database.
        .filter((monitor) => (GC.PROBE_ELIGIBLE_TYPES as readonly string[]).includes(monitor.monitor_type))
        .map((monitor) => ({
          tag: monitor.tag,
          name: monitor.name,
          monitor_type: monitor.monitor_type,
        })),
    };
  },
} satisfies ActionDefinition;

function parseCapabilities(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}
