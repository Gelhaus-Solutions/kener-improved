import db from "$lib/server/db/db.js";
import GC from "$lib/global-constants.js";
import { MERGED_REGION_ID } from "$lib/server/db/regions.js";
import { getConnection } from "$lib/server/probes/registry.js";
import { configuredPort } from "$lib/server/probes/wsServer.js";
import { GetSiteDataByKey } from "$lib/server/controllers/siteDataController.js";
import { parseMergeDefaults, MERGE_POLICIES, SOURCE_MODES, LOCAL_REGION_ID } from "$lib/server/probes/merge.js";
import { REGION_RULES } from "$lib/server/probes/assignment.js";
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
    const [agents, assignments, regions, monitors, mergeRegions, storedPolicy, regionRules, overrides] =
      await Promise.all([
        db.getProbeAgents(),
        db.getProbeAssignments(),
        db.getAssignableRegions(),
        db.getMonitors({ status: "ACTIVE" }),
        db.getMergeRegions(),
        GetSiteDataByKey("probeMergePolicy"),
        db.getProbeRegionRules(),
        db.getMonitorRegionOverrides(),
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
          note: "An agent here runs the local check remotely: Kener stops checking these monitors from its own server and this agent's answer takes local's place in the merge.",
        },
        ...regions
          .filter((region) => region.id !== MERGED_REGION_ID)
          .map((region) => ({
            ...region,
            note: "An agent here observes as its own region, alongside the local check. How much its answer counts is set below.",
          })),
      ],
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        region_id: agent.region_id,
        // B1g. This projection is an allowlist, so a column left out of it
        // reaches the screen as undefined rather than as a missing field.
        weight: agent.weight ?? 1,
        status: agent.status,
        connection_state: agent.connection_state,
        live: canSeeConnections ? !!getConnection(agent.id) : null,
        token_hint: agent.token_hint,
        agent_version: agent.agent_version,
        capabilities: parseCapabilities(agent.capabilities),
        last_seen_at: agent.last_seen_at,
      })),
      assignments,

      // B1e. The region is the unit of configuration now, so the screen is
      // given the rule and the exceptions rather than being left to infer them
      // from the resolved rows. A region with no rule row is NONE, which is the
      // same thing the resolver believes.
      region_rules: regionRules.map((row) => ({ region_id: row.region_id, rule: row.rule, mode: row.mode })),
      region_overrides: overrides.map((row) => ({
        monitor_tag: row.monitor_tag,
        region_id: row.region_id,
        decision: row.decision,
      })),
      region_rule_values: REGION_RULES,

      // B1d. The cascade's top two levels, so the screen can show what a source
      // actually resolves to rather than only what it overrides.
      merge_policy: parseMergeDefaults(storedPolicy),
      merge_policies: MERGE_POLICIES,
      source_modes: SOURCE_MODES,
      local_region_id: LOCAL_REGION_ID,
      merge_regions: mergeRegions.map((region) => ({
        id: region.id,
        code: region.code,
        name: region.name,
        is_active: !!region.is_active,
        default_weight: region.default_weight,
        default_trust_rank: region.default_trust_rank,
        default_mode: region.default_mode,
        // Region 0 is the computed answer, so nothing observes there and it has
        // nothing to configure. Listed anyway, because an operator looking for
        // it should find it explained rather than absent.
        configurable: region.id !== MERGED_REGION_ID,
      })),

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
