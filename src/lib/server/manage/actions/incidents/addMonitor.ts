import { AddIncidentMonitor } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Attaches a monitor to an incident with an impact.
 *
 * Takes `component_impact` when the caller sends one (C2) and falls back to
 * `monitor_impact`. Both names reach the same parameter, which accepts either
 * vocabulary - the fallback exists so an inherited API client that still sends
 * the mechanical value keeps working, rather than to leave the admin screen a
 * choice about which to send. It sends the communication value.
 */
export default {
  action: "addMonitor",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await AddIncidentMonitor(data.incident_id, data.monitor_tag, data.component_impact ?? data.monitor_impact);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
