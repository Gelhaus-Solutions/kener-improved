import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { GetPageByPathWithMonitors } from "$lib/server/controllers/controller.js";

// G7. Existence check only: the history itself is fetched by the component,
// keyset page by keyset page. Without this a typo'd page path would render an
// empty history rather than a 404, which reads as "we had no incidents".
export const load: PageServerLoad = async ({ params }) => {
  const pageData = await GetPageByPathWithMonitors(params.page_path);
  if (!pageData) throw error(404, "Page Not Found");
  return { pagePath: params.page_path };
};
