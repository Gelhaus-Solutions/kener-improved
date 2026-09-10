import {
  ORG_STATUS_ACTIVE,
  ORG_STATUS_SUSPENDED,
  SetInstanceOrgStatus,
} from "$lib/server/controllers/instanceController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface SetInstanceOrgStatusPayload {
  org_id: number;
  status: string;
}

/**
 * Suspends or reactivates an organisation. Superadmin only (KENER-31).
 *
 * The one write the instance console holds, and it reaches no further than a
 * single column on `orgs`. Everything suspension does follows from four existing
 * readers of that column; see `SetInstanceOrgStatus`.
 */
export default {
  action: "setInstanceOrgStatus",
  permission: null,
  superadmin: true,
  schema: (data: Record<string, unknown>): SetInstanceOrgStatusPayload => {
    const orgId = Number(data.org_id);
    if (!Number.isInteger(orgId) || orgId <= 0) throw new ActionError(400, "org_id must be a positive integer");
    const status = String(data.status ?? "").toUpperCase();
    if (status !== ORG_STATUS_ACTIVE && status !== ORG_STATUS_SUSPENDED) {
      throw new ActionError(400, `status must be ${ORG_STATUS_ACTIVE} or ${ORG_STATUS_SUSPENDED}`);
    }
    return { org_id: orgId, status };
  },
  handler: async (data: SetInstanceOrgStatusPayload) => {
    try {
      await SetInstanceOrgStatus(data.org_id, data.status);
    } catch (e) {
      throw new ActionError(400, e instanceof Error ? e.message : "Could not change that organisation");
    }
    return { ok: true };
  },
} satisfies ActionDefinition<SetInstanceOrgStatusPayload>;
