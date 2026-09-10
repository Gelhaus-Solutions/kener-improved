import type { RequestHandler } from "./$types";
import { renderRssFeedResponse } from "$lib/server/rss.js";

// G4. See the monitor feed for why the host is passed.
export const GET: RequestHandler = ({ params, request }) =>
  renderRssFeedResponse({
    scope: { type: "page", pagePath: params.page_path },
    feedPath: `/${params.page_path}/rss.xml`,
    requestHost: request.headers.get("host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
  });
