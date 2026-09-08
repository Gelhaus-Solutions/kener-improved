import { GetMfaCoverage } from "$lib/server/controllers/mfaController.js";
import { InsertKeyValue } from "$lib/server/controllers/siteDataController.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface Payload {
  policy: string;
}

const VALID: ReadonlySet<string> = new Set(["none", "local_only", "all"]);

/**
 * Sets the instance MFA policy.
 *
 * A fork-invented action rather than a use of `storeSiteData`, for one reason:
 * the guard below. `storeSiteData` is upstream's generic site_data writer, and
 * putting a key-specific refusal inside it would both diverge a file we want to
 * merge cleanly and hide a security decision somewhere nobody would look for it.
 *
 * **The guard: an operator cannot require a factor they do not hold.** Switching
 * to `all` (or to `local_only` as a local user) takes effect on their very next
 * request, so an operator without a factor locks themselves out with the same
 * click that locks out everyone else - and the only way back is editing
 * `site_data` by hand in the database. They are the one person for whom this is
 * cheaply checkable, so it is checked.
 *
 * Loosening the policy is never blocked: it cannot lock anybody out.
 */
export default {
  action: "setMfaPolicy",
  permission: "settings.write",
  audit: { targetType: "site_settings" },
  handler: async (data: Payload, ctx: ActionContext) => {
    const policy = String(data.policy ?? "");
    if (!VALID.has(policy)) {
      throw new ActionError(400, "Policy must be one of: none, local_only, all");
    }

    const coverage = await GetMfaCoverage(ctx.user.id);

    // Would this setting apply to the person making the change? An OIDC user is
    // exempt under `local_only`, so only `all` can strand them.
    const wouldBindCaller = policy === "all" || (policy === "local_only" && ctx.user.auth_provider !== "oidc");

    // A session that cleared a factor at the identity provider already satisfies
    // the policy, so that operator is not about to strand themselves.
    const callerSatisfied = coverage.caller_covered || ctx.session.mfa_level === "idp";

    if (wouldBindCaller && !callerSatisfied) {
      throw new ActionError(
        400,
        "Enrol your own second factor before requiring one. This change would lock you out on your next request.",
      );
    }

    await InsertKeyValue("mfaPolicy", policy);

    return { success: true, policy, coverage: await GetMfaCoverage(ctx.user.id) };
  },
} satisfies ActionDefinition<Payload>;
