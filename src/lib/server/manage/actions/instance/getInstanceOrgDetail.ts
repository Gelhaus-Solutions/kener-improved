import { GetInstanceOrgDetail } from "$lib/server/controllers/instanceController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface GetInstanceOrgDetailPayload {
  org_id: number;
}

/** One organisation's hostnames and members. Read-only, superadmin only (KENER-31). */
export default {
  action: "getInstanceOrgDetail",
  permission: null,
  superadmin: true,
  schema: (data: Record<string, unknown>): GetInstanceOrgDetailPayload => {
    const orgId = Number(data.org_id);
    if (!Number.isInteger(orgId) || orgId <= 0) throw new ActionError(400, "org_id must be a positive integer");
    return { org_id: orgId };
  },
  handler: async (data: GetInstanceOrgDetailPayload) => {
    try {
      return await GetInstanceOrgDetail(data.org_id);
    } catch (e) {
      throw new ActionError(404, e instanceof Error ? e.message : "Organisation not found");
    }
  },
} satisfies ActionDefinition<GetInstanceOrgDetailPayload>;
