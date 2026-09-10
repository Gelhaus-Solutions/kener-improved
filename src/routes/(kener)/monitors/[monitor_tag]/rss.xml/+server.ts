import type { RequestHandler } from "./$types";
import { renderRssFeedResponse } from "$lib/server/rss.js";

// G4. The host is passed so the feed's links point at the domain it was
// requested on. Every feed route does this; one that forgot would emit the
// instance's `siteURL` and quietly send subscribers to the wrong site.
export const GET: RequestHandler = ({ params, request }) =>
  renderRssFeedResponse({
    scope: { type: "monitor", tag: params.monitor_tag },
    feedPath: `/monitors/${params.monitor_tag}/rss.xml`,
    requestHost: request.headers.get("host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
  });
