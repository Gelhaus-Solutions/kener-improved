import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";
import { resolve } from "$app/paths";
import { GetLayoutServerData } from "$lib/server/controllers/layoutController";
import serverResolve from "$lib/server/resolver.js";

export const load: LayoutServerLoad = async ({ cookies, request, locals }) => {
  const data = await GetLayoutServerData(cookies, request);
  if (!data.isSetupComplete) {
    throw redirect(302, serverResolve(`/account/signin`));
  }

  return {
    ...data,
    // G4. The page this hostname is bound to, or null on a shared host.
    //
    // Carried in layout data rather than resolved per route: several root-level
    // routes (the dashboard, the events archive, the history) each render "the
    // home page" today, and teaching every one of them about custom domains
    // separately is how one gets missed. Client components read it as
    // `page.data.boundPagePath`.
    boundPagePath: locals.pagePath ?? null,
  };
};
