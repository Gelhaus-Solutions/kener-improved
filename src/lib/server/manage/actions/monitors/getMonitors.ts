import db from "$lib/server/db/db.js";
import { GetMonitors } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged except for
 * the opt-in filter below.
 */
export default {
  action: "getMonitors",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any = await GetMonitors(data);

    /**
     * B12c. Leave out the regional endpoints of multi-region services.
     *
     * **Opt-in, never the default.** Every regional endpoint IS an ordinary
     * monitor and there are screens that must keep seeing it - a monitor list an
     * operator is debugging from, anything that edits or deletes it. What must
     * NOT see it is a PICKER: offering `shop__eu-central` as a group member, a
     * maintenance target or a page entry turns one service back into three,
     * which is the thing multi-region exists to stop. So the call sites that are
     * pickers ask for the filter and nothing else changes.
     *
     * Hidden-ness is not enough on its own. `getMonitors` deliberately returns
     * hidden monitors, because an admin screen is exactly where a hidden monitor
     * has to be visible.
     */
    if (data.exclude_region_endpoints === true && Array.isArray(resp)) {
      const endpoints = await db.getAllRegionTargetChildTags();
      if (endpoints.size > 0) {
        resp = resp.filter((monitor: { tag?: string }) => !endpoints.has(String(monitor.tag)));
      }
    }

    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
