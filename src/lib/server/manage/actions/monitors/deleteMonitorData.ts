import { isMonitoringStatus } from "$lib/global-constants.js";
import db from "$lib/server/db/db";
import { type MonitoringStatus } from "$lib/types/status.js";
import { json } from "@sveltejs/kit";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "deleteMonitorData",
  audit: { targetType: "monitor" },
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    let status: MonitoringStatus | undefined;
    if (data.status !== undefined && data.status !== null && data.status !== "ALL") {
      if (!isMonitoringStatus(data.status)) {
        return json({ error: "Invalid monitoring status" }, { status: 400 });
      }
      status = data.status;
    }
    await db.deleteMonitorDataByTag(data.tag || undefined, data.start, data.end, status);
    resp = { success: true };
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
