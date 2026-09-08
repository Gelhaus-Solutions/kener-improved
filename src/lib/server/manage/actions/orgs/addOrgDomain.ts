import { AddOrgDomain } from "$lib/server/controllers/orgController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface AddOrgDomainPayload {
  hostname: string;
}

/**
 * Points a hostname at the current org.
 *
 * `orgs.write` rather than a domain permission of its own: a hostname is how the
 * public reaches a tenant, so adding one is the same class of act as renaming the
 * org, and splitting it would be a permission nobody would think to grant.
 */
export default {
  action: "addOrgDomain",
  permission: "orgs.write",
  schema: (data: Record<string, unknown>): AddOrgDomainPayload => {
    const hostname = String(data.hostname ?? "").trim();
    if (!hostname) throw new ActionError(400, "A hostname is required");
    return { hostname };
  },
  handler: async (data: AddOrgDomainPayload, ctx: ActionContext) => {
    try {
      await AddOrgDomain(ctx.orgId, data.hostname);
    } catch (e) {
      throw new ActionError(400, e instanceof Error ? e.message : "Could not add that hostname");
    }
    return { ok: true };
  },
} satisfies ActionDefinition<AddOrgDomainPayload>;
