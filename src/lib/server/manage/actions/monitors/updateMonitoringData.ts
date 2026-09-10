import GC from "$lib/global-constants.js";
import { normaliseMonitoringDataUpdate, UpdateMonitoringData } from "$lib/server/controllers/controller.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Rewrites a monitor's history over a window.
 *
 * The `schema` is the point of this file (KENER-121). This action used to pass
 * the payload straight through, and the controller validated nothing, so a
 * caller who sent `status` instead of `newStatus` - a reasonable guess, since
 * every other monitoring-data shape in the codebase calls the column `status` -
 * overwrote one row per minute of the window with a **null status** and got a
 * 200 back. The screen was never wrong; this was an API-only hole, which is why
 * it survived.
 *
 * Validation itself lives in the controller, because `/api/v4` shares it. Here
 * it is only run early enough, and wrapped tightly enough, that a bad payload
 * gets the 400 it deserves rather than the 500 an uncaught `Error` becomes.
 */
export default {
  action: "updateMonitoringData",
  schema: (data: Record<string, unknown>): LegacyPayload => {
    try {
      // Type is fixed here, not taken from the caller: this path writes MANUAL
      // by definition, and letting a payload choose would let it forge a
      // REALTIME sample.
      return { ...normaliseMonitoringDataUpdate(data as never), type: GC.MANUAL };
    } catch (e) {
      throw new ActionError(400, e instanceof Error ? e.message : "Invalid monitoring data update");
    }
  },
  handler: async (data: LegacyPayload) => {
    return await UpdateMonitoringData(data);
  },
} satisfies ActionDefinition<LegacyPayload>;
