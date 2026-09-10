import { json } from "@sveltejs/kit";
import type { APIServerRequest } from "$lib/server/types/api-server";
import { GetSwitcherPages } from "$lib/server/controllers/pagesController";

/**
 * GET /dashboard-apis/pages
 *
 * The pages the public switcher may list, as PageNavItem[].
 *
 * Delegates to `GetSwitcherPages` rather than resolving the list itself (G3).
 * This endpoint used to apply `pageOrderingSettings` with its own copy of the
 * sort, which was fine until the switcher grew a second rule - a per-page
 * `listed` flag - that this copy would not have known about. Two lists of "the
 * public pages" that disagree is a bug nobody notices until a page an operator
 * hid turns up in something.
 */
export default async function get(_req: APIServerRequest): Promise<Response> {
  return json(await GetSwitcherPages());
}
