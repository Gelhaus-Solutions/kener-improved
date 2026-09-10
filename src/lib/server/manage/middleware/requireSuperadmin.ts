import { IsInstanceSuperadmin } from "$lib/server/controllers/instanceController.js";
import { ActionError } from "../types.js";
import type { ActionContext, AnyActionDefinition } from "../types.js";

/**
 * Enforces `superadmin: true` on an action definition (KENER-31).
 *
 * **Position: immediately after `authorize`, and after `requireOrg`.** After
 * authorize because the two are the same kind of refusal and should read the
 * same way to the caller; after requireOrg because a superadmin acting through
 * the admin API is still a signed-in member of some org, and the audit row for
 * what they did belongs in the org they were acting in rather than nowhere.
 *
 * The gate is `users.is_owner`, which no screen and no role can grant. See
 * `instanceController.ts` for why it is a column and not a permission.
 *
 * 403 with the same wording `authorize` uses. A caller who is not the superadmin
 * has nothing to learn from a more specific message, and the instance console is
 * not a fact the admin API needs to confirm to a tenant's administrator.
 */
export function requireSuperadmin(def: AnyActionDefinition | undefined, ctx: ActionContext): void {
  if (!def?.superadmin) return;
  if (IsInstanceSuperadmin(ctx.user)) return;
  throw new ActionError(403, "You do not have permission to perform this action");
}
