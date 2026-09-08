import { BeginMfaEnrolment } from "$lib/server/controllers/mfaController.js";
import { GetSiteDataByKey } from "$lib/server/controllers/siteDataController.js";
import { requireFreshPassword } from "./requireFreshPassword.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface Payload {
  password: string;
}

/**
 * Starts enrolment and returns the QR code.
 *
 * **Requires the current password**, which is the one deviation from the item's
 * design here. It specified a "fresh session" - a password re-entered within the
 * last five minutes, unlocking a window. Asking for the password at the
 * sensitive step instead gives the same guarantee with no window to track, no
 * new column, and no five-minute period during which a borrowed logged-in laptop
 * can silently enrol a factor the owner does not hold.
 *
 * Never audited with its payload: it contains a password.
 */
export default {
  action: "beginMfaEnrolment",
  permission: null,
  audit: false,
  handler: async (data: Payload, ctx: ActionContext) => {
    await requireFreshPassword(ctx.user.id, data.password, ctx.user.auth_provider);

    const siteName = (await GetSiteDataByKey("siteName")) || "Kener";
    return await BeginMfaEnrolment(ctx.user.id, ctx.user.email, String(siteName));
  },
} satisfies ActionDefinition<Payload>;
