import { CanCreateOrg, CreateOrganisation } from "$lib/server/controllers/orgController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface CreateOrganisationPayload {
  name: string;
  slug: string;
}

/**
 * Creates an organisation, with the caller as its owner.
 *
 * **Two checks, not one.** `orgs.write` is the permission, and the pipeline
 * applies it in whichever org the caller is currently acting in - which is not
 * enough on its own, because roles are per-org and the administrator of any
 * tenant would otherwise be able to mint further tenants. `CanCreateOrg` asks the
 * narrower question: do they hold `orgs.write` in the *default* org, which is the
 * closest thing this schema has to "runs the instance".
 *
 * The permission is still declared, rather than being left to `CanCreateOrg`
 * alone, so that the action appears in the permission map like every other and an
 * operator who has taken `orgs.write` away has actually taken it away.
 */
export default {
  action: "createOrganisation",
  permission: "orgs.write",
  schema: (data: Record<string, unknown>): CreateOrganisationPayload => {
    const name = String(data.name ?? "").trim();
    const slug = String(data.slug ?? "").trim();
    if (!name || !slug) throw new ActionError(400, "A name and a slug are required");
    return { name, slug };
  },
  handler: async (data: CreateOrganisationPayload, ctx: ActionContext) => {
    if (!(await CanCreateOrg(ctx.user.id))) {
      throw new ActionError(403, "Only an administrator of the default organisation can create organisations");
    }
    try {
      return await CreateOrganisation(ctx.user.id, data);
    } catch (e) {
      throw new ActionError(400, e instanceof Error ? e.message : "Could not create the organisation");
    }
  },
} satisfies ActionDefinition<CreateOrganisationPayload>;
