import { ListDockerContainers } from "$lib/server/controllers/dockerController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Transcribed from the inherited action chain; behaviour unchanged.
 */
export default {
  action: "listDockerContainers",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await ListDockerContainers(data);
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
