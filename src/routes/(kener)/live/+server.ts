import type { RequestHandler } from "./$types";
import { currentOrgId } from "$lib/server/events/eventContext";
import { GetPageByPathWithMonitors } from "$lib/server/controllers/pagesController";
import { addListener, connectionCount, replaySince, type LiveMessage } from "$lib/server/live/hub";

// G5: the public live-update stream.
//
// SSE rather than the probe WebSocket, because the two channels have opposite
// shapes: the probe channel is authenticated, bidirectional, few and long-lived;
// this one is anonymous, unidirectional, high fan-out, and has to survive
// arbitrary reverse proxies. Sharing them would mean authenticating every
// anonymous visitor and upgrading every public connection for no benefit.
//
// **THE LANDMINE THIS ENDPOINT IS BUILT AROUND: the org context is gone by the
// time the stream produces anything.** `orgResolveHandle` wraps `resolve(event)`
// in `runWithOrg`, and an SSE response *returns as soon as its headers are
// sent*. Everything the `ReadableStream` does afterwards runs outside that
// AsyncLocalStorage scope, so any repository call from inside `start` or `pull`
// would throw `MissingOrgContextError` - not on the first request in
// development, but on whichever request first outlived the handler.
//
// The fix is structural rather than a re-entry: **everything the stream needs is
// resolved here, in the handler, while the context still exists**, and the
// stream itself touches no database at all. That is also why `LiveEvent`
// payloads are self-contained - the moment a stream needs to look something up,
// this whole problem comes back.

/** Comment frame interval. Under the 30s and 60s idle timeouts proxies default to. */
const HEARTBEAT_MS = 25_000;

/**
 * How many streams this process will hold.
 *
 * SSE costs a socket per viewer for as long as they keep the page open, which
 * caps concurrent readers far below a stateless page. Bounded on purpose: an
 * unbounded anonymous resource on a public status page is exactly the thing that
 * only fails under the traffic you least want it to fail under.
 */
const MAX_CONNECTIONS = Number(process.env.KENER_SSE_MAX_CONNECTIONS ?? 1000);

/** What a client is told to wait before reconnecting, in normal operation. */
const RETRY_MS = 5_000;

/** ...and after being turned away, so a full instance is not hammered. */
const BUSY_RETRY_MS = 60_000;

function frame(message: LiveMessage): string {
  return `id: ${message.id}\nevent: ${message.event.kind}\ndata: ${JSON.stringify(message.event)}\n\n`;
}

export const GET: RequestHandler = async ({ url, request }) => {
  // Resolved here, inside the org context. See the header.
  const orgId = currentOrgId();

  // Which page the viewer has open, so a stream carries that page's monitors and
  // nothing else. Absent means the home page, whose `page_path` is "".
  const pagePath = url.searchParams.get("page") ?? "";
  const pageData = await GetPageByPathWithMonitors(pagePath);

  const allowedTags = new Set((pageData?.monitors ?? []).map((m) => m.monitor_tag));
  const pageId = pageData?.page.id ?? null;

  const headers = {
    "content-type": "text/event-stream",
    // `no-transform` matters as much as `no-cache`: a proxy that helpfully
    // gzips or rechunks an event-stream buffers it, and the stream arrives in
    // one lump when the connection closes.
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // nginx buffers proxied responses by default, which defeats SSE entirely.
    "x-accel-buffering": "no",
  };

  // Over capacity: accept, tell the client to come back later, and close.
  // Deliberately not a 503 - `EventSource` treats any non-200 as a hard error
  // and retries on its own schedule, ignoring the `retry:` hint, so a full
  // instance would be reconnected at faster than it could shed load.
  if (orgId === null || connectionCount() >= MAX_CONNECTIONS) {
    return new Response(`retry: ${BUSY_RETRY_MS}\n: capacity\n\n`, { headers });
  }

  const lastEventId = Number(request.headers.get("last-event-id") ?? "0");

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client is gone and the controller is already closed. Stop
          // writing rather than throwing out of a timer callback, which would
          // be an unhandled rejection in the web process.
          closed = true;
          cleanup();
        }
      };

      const cleanup = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };

      /** Only what this page shows. A viewer must not learn about other pages. */
      const relevant = (message: LiveMessage): boolean => {
        if (message.event.kind === "monitor_status") return allowedTags.has(message.event.monitor_tag);
        return pageId !== null && message.event.page_id === pageId;
      };

      send(`retry: ${RETRY_MS}\n\n`);

      // `Last-Event-ID` resume. Best effort by design: see REPLAY_BUFFER in the
      // hub. Replayed before the listener is attached so ordering holds.
      if (Number.isFinite(lastEventId) && lastEventId > 0) {
        for (const missed of replaySince(orgId, lastEventId)) {
          if (relevant(missed)) send(frame(missed));
        }
      }

      unsubscribe = addListener(orgId, (message) => {
        if (relevant(message)) send(frame(message));
      });

      // A comment frame. Defeats proxy idle timeouts and, just as usefully, is
      // how this process notices a client that vanished without a FIN: the
      // enqueue throws and the stream is cleaned up.
      heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);
    },

    cancel() {
      // The viewer navigated away or closed the tab.
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  });

  return new Response(stream, { headers });
};
