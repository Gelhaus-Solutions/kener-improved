import { GetPageByPathWithMonitors } from "../controllers/pagesController.js";
import { ResolveVisiblePublicMonitor } from "../controllers/publicMonitorResolver.js";

/**
 * G5/B13: what one public live stream is allowed to hear.
 *
 * **Its own module because it is the access-control decision, not plumbing.**
 * The endpoint around it is a `ReadableStream` and a heartbeat; this is the part
 * that answers "may this viewer be told about this monitor", and it is the part
 * worth being able to test without opening a socket.
 *
 * Resolved in the request handler, never inside the stream. An SSE response
 * returns as soon as its headers are sent, so everything the stream does
 * afterwards runs outside the org's AsyncLocalStorage scope and any repository
 * call from in there would throw. See the endpoint's header.
 */
export interface LiveScope {
  /** Physical monitor tags this stream may carry events for. */
  allowedTags: Set<string>;
  /** The page whose overall status it may carry, or null for none. */
  pageId: number | null;
}

/**
 * The scope for a stream's query string.
 *
 * Two shapes, and `monitor` wins when both are present because it is strictly
 * the narrower: one monitor and no page status, versus a whole page's monitor
 * list. A caller sending both has asked two questions, and answering with the
 * wider of the two would be the wrong way to resolve that.
 */
export async function resolveLiveScope(params: URLSearchParams): Promise<LiveScope> {
  const monitorName = params.get("monitor");

  if (monitorName !== null) {
    // B13. **A monitor page is not a page.** `?page=` resolves a status page's
    // monitor list and `/monitors/<slug>` is not in that table at all, so a
    // monitor page connecting with the default would be handed the HOME page's
    // allowlist - allowing whatever is listed there and refusing the monitor
    // actually on screen.
    //
    // `ResolveVisiblePublicMonitor` and nothing looser: it is the same "ACTIVE
    // and not hidden" test `(kener)/monitors/[monitor_tag]` answers 404 on, so a
    // monitor nobody may open is a monitor nobody may subscribe to. This adds no
    // reachable information - a viewer who can open that page is already served
    // the same monitor's status and its whole region map at load.
    const monitor = await ResolveVisiblePublicMonitor(monitorName);

    return {
      // The PHYSICAL tag, not the URL segment. The public URL carries the
      // per-org slug and every event on the wire carries the tag, so allowing
      // the slug would be an allowlist matching nothing at all on an org with a
      // `tag_prefix`: a stream that connects, stays open, and silently never
      // updates.
      //
      // An unknown or hidden name leaves this EMPTY rather than erroring. The
      // stream connects and delivers nothing, which fails closed and declines to
      // tell a prober which monitor names exist.
      allowedTags: new Set(monitor ? [monitor.tag] : []),
      // A monitor scope carries no page, so `page_status` can never match. Not
      // an omission: the viewer is looking at one service, and a page headline
      // they cannot see is not theirs to be told about.
      pageId: null,
    };
  }

  // Which page the viewer has open, so a stream carries that page's monitors and
  // nothing else. Absent means the home page, whose `page_path` is "".
  const pagePath = params.get("page") ?? "";
  const pageData = await GetPageByPathWithMonitors(pagePath);

  return {
    allowedTags: new Set((pageData?.monitors ?? []).map((m) => m.monitor_tag)),
    pageId: pageData?.page.id ?? null,
  };
}
