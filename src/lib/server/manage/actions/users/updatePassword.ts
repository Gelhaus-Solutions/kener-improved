import { UpdatePassword } from "$lib/server/controllers/controller.js";
import type { ActionDefinition } from "../../types.js";

/**
 * ACTION_PERMISSION_MAP maps this to `null`: a self-action, where being logged
 * in is the whole authorization story. The pipeline handles that; there is
 * nothing to declare here.
 *
 * The user id comes from the session via `ctx`, never from the payload. That was
 * already true (the chain overwrote `data.userID` before calling through) and it
 * is the only thing standing between this action and changing someone else's
 * password, so it is worth being explicit that the payload cannot influence it.
 */
interface UpdatePasswordPayload {
  newPassword: string;
  newPlainPassword: string;
}

export default {
  action: "updatePassword",
  // Narrows the payload for the handler; it does not validate the password.
  // UpdatePassword owns the strength and match rules, and duplicating them here
  // would give two places to disagree.
  schema: (data): UpdatePasswordPayload => ({
    newPassword: String(data.newPassword ?? ""),
    newPlainPassword: String(data.newPlainPassword ?? ""),
  }),
  handler: async (data, ctx) => await UpdatePassword({ ...data, userID: ctx.user.id }),
} satisfies ActionDefinition<UpdatePasswordPayload>;
