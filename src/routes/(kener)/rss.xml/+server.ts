import type { RequestHandler } from "./$types";
import { renderRssFeedResponse } from "$lib/server/rss.js";

// G4. On a hostname bound to a page this is that page's feed, not the whole
// site's: a customer's own domain must not syndicate another page's incidents.
// `null` - every item the site publishes - remains the answer on a shared host.
export const GET: RequestHandler = ({ locals, request }) =>
  renderRssFeedResponse({
    scope: { type: "page", pagePath: locals.pagePath ?? null },
    feedPath: "/rss.xml",
    requestHost: request.headers.get("host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
  });
