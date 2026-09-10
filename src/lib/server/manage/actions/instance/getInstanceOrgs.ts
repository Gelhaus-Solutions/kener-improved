import { GetInstanceOrgs } from "$lib/server/controllers/instanceController.js";
import type { ActionDefinition } from "../../types.js";

/** Every organisation on the instance, with row counts. Superadmin only (KENER-31). */
export default {
  action: "getInstanceOrgs",
  // No per-org permission can be the right answer for an instance-wide read;
  // `superadmin` is the gate. See types.ts and instanceController.ts.
  permission: null,
  superadmin: true,
  handler: async () => {
    return { orgs: await GetInstanceOrgs() };
  },
} satisfies ActionDefinition;
