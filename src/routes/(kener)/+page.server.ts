import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { GetPageDashboardData } from "$lib/server/controllers/dashboardController.js";

export const load: PageServerLoad = async ({ parent, locals }) => {
  const layoutData = await parent();
  // G4. On a hostname bound to a page, the site root *is* that page. Falls back
  // to the home page's empty path, which is every request on a shared host.
  const dashboardData = await GetPageDashboardData(locals.pagePath ?? "", layoutData);
  if (!dashboardData) {
    throw error(404, "Page Not Found");
  }
  return {
    ...dashboardData,
  };
};
