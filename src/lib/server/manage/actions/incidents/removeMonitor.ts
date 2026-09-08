import { RemoveIncidentMonitor } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "removeMonitor",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await RemoveIncidentMonitor(data.incident_id, data.monitor_tag);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
