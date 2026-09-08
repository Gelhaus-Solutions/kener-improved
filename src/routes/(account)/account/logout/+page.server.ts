import { redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import serverResolve from "$lib/server/resolver.js";
import { EndSession } from "$lib/server/controllers/sessionController.js";

export const load: PageServerLoad = async () => {
  throw redirect(302, serverResolve("/account/signin"));
};

export const actions: Actions = {
  default: async ({ cookies }) => {
    // Revokes the session row and then clears the cookie. Deleting the cookie
    // alone was the whole of logging out before, which meant a copied cookie
    // stayed valid for its remaining year after the user pressed "log out".
    await EndSession(cookies, "logout");
    throw redirect(302, serverResolve("/account/signin"));
  },
};
