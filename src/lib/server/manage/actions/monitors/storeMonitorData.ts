import { GetMonitorsParsed } from "$lib/server/controllers/controller.js";
import { CreateUpdateMonitor } from "$lib/server/controllers/controller.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "storeMonitorData",
  // Before/after on this one: it is a config change people ask questions about later.
  audit: { targetType: "monitor", snapshot: async (data) => (data.tag ? (await GetMonitorsParsed({ tag: String(data.tag) }))[0] : undefined) },
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await CreateUpdateMonitor(data);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
