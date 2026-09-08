import { GetIncidentByIDDashboard } from "$lib/server/controllers/controller.js";
import { UpdateIncident } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "updateIncident",
  // Before/after on this one: it is a config change people ask questions about later.
  audit: { targetType: "incident", snapshot: async (data) => (data.id ? await GetIncidentByIDDashboard({ incident_id: Number(data.id) }) : undefined) },
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await UpdateIncident(data.id, data);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
