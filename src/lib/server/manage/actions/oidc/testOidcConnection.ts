import { TestOidcConnection } from "$lib/server/controllers/oidcController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "testOidcConnection",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await TestOidcConnection(data.settings);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
