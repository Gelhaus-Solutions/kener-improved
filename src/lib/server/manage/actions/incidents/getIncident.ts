import { GetIncidentByIDDashboard } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "getIncident",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await GetIncidentByIDDashboard(data);
    if (!!!resp) {
      throw new Error("Incident not found");
    }
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
