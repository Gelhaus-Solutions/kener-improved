import { uploadImage } from "$lib/server/controllers/imageController.js";
import type { ActionDefinition, LegacyPayload } from "../../types.js";

/**
 * Upstream moved the upload into `imageController` (#890), which the v4 API
 * shares. The 256px bound is the dashboard's, kept as the default here.
 */
export default {
  action: "uploadImage",
  handler: async (data: LegacyPayload) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any;
    resp = await uploadImage({ maxWidth: 256, maxHeight: 256, ...data });
    return resp;
  },
} satisfies ActionDefinition<LegacyPayload>;
