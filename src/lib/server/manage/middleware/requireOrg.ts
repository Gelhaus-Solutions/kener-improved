import db from "$lib/server/db/db.js";
import { DEFAULT_ORG_ID, enterOrg, runAcrossOrgs } from "$lib/server/db/orgContext.js";
import { ActionError } from "../types.js";
import type { ActionContext } from "../types.js";

/**
 * Asserts the caller belongs to the org this request targets, **and** establishes
 * the org context the rest of the request runs in.
 *
 * Those two things are one function on purpose. If establishing the context were
 * separate from checking membership, there would exist an ordering in which code
 * gets a usable org context without the check having run, and that ordering
 * eventually gets written. Keeping them fused means the context cannot be
 * obtained without being entitled to it.
 *
 * Position in the pipeline is equally deliberate: this runs **before** validation
 * and before the audit before-snapshot, because a snapshot query issued without
 * an org context reads across tenants.
 *
 * **The org comes from the session, not the hostname.** `orgResolveHandle` has
 * already established a host-derived org for the request, and for admin traffic
 * that is the wrong answer: an operator administering three tenants reaches all
 * of them through one hostname, and which one they are acting in is a property of
 * their session. `sessions.active_org_id` carries it, and this overrides.
 *
 * A session can name any org id it likes, so membership is what makes it
 * legitimate. `org_members` is read across orgs because it is what determines the
 * org - it cannot be filtered by the answer it is producing.
 */
export async function requireOrg(ctx: ActionContext): Promise<number> {
  const requested = ctx.session.active_org_id ?? DEFAULT_ORG_ID;

  const isMember = await runAcrossOrgs(() => db.isOrgMember(requested, ctx.user.id));
  if (!isMember) {
    // 403 rather than 404: the caller is authenticated and their session simply
    // points somewhere they may not go, most likely because their membership was
    // revoked while they were signed in. Saying "not found" would be a lie that
    // sends them to look for a bug.
    throw new ActionError(403, "You are not a member of this organisation");
  }

  enterOrg(requested);
  return requested;
}
