import { DeleteMonitorAlertV2 } from "$lib/server/controllers/monitorAlertConfigController.js";
import db from "$lib/server/db/db";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "deleteMonitorAlertV2",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    const deleteIncident = data.deleteIncident === true;
    // If deleteIncident is true, delete the incident first
    if (deleteIncident && data.incident_id) {
      await db.deleteIncident(data.incident_id);
    }
    resp = await DeleteMonitorAlertV2(data.id);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
