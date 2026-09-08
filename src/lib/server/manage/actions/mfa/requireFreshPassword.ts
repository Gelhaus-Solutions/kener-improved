import bcrypt from "bcrypt";
import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";

/**
 * Refuses unless the caller can present their current password.
 *
 * Guards the actions that change what it takes to get into an account: enrolling
 * a factor, confirming it, disabling it, regenerating recovery codes. Without
 * this, anyone who walked up to an unlocked, signed-in browser could enrol their
 * own authenticator and lock the owner out of their own account.
 *
 * The comparison is always performed, even when the user has no password, so the
 * response time does not reveal which accounts are SSO-only.
 */
export async function requireFreshPassword(userId: number, password: unknown): Promise<void> {
  const supplied = typeof password === "string" ? password : "";
  const stored = await db.getUserPasswordHashById(userId);
  const hash = stored?.password_hash || "";

  // A syntactically valid bcrypt hash that nothing matches, so the compare costs
  // the same when there is no password to check against.
  const DUMMY = "$2b$10$0000000000000000000000000000000000000000000000000000";
  const matches = await bcrypt.compare(supplied, hash || DUMMY);

  if (!hash || !matches) {
    throw new ActionError(401, "That password is not correct");
  }
}
