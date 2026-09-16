import { error, type RequestHandler } from "@sveltejs/kit";
import { authenticate } from "$lib/server/manage/middleware/authenticate";
import { requireOrg } from "$lib/server/manage/middleware/requireOrg";
import { requireMfaEnrolment } from "$lib/server/manage/middleware/requireMfa";
import { ActionError } from "$lib/server/manage/types";
import type { ActionContext } from "$lib/server/manage/types";
import { addListener, type LiveMessage } from "$lib/server/live/hub";

/**
 * B13. The admin probes screen's live fleet map.
 *
 * **Why this exists next to `(kener)/live`, which carries the same events.** That
 * endpoint is anonymous by design and scoped to what one public surface shows -
 * a status page's monitors, or since B13 a single monitor. Neither scope is the
 * fleet: an operator is asking "which of my regions is alive", which is every
 * region and no monitor in particular. Pointing the probes screen at the public
 * stream would have meant either widening an anonymous endpoint to the whole
 * instance, or showing operators a fleet map missing the regions that only watch
 * monitors not listed on some page.
 *
 * **Everything below the auth block is the same shape as `(kener)/live`, and the
 * same landmine applies with more force here.** An SSE response returns as soon
 * as its headers are sent, so everything the `ReadableStream` does afterwards
 * runs outside the AsyncLocalStorage scope `requireOrg` established - and
 * outside the session, too. The org id is resolved here, in the handler, and the
 * stream itself touches no database and re-checks nothing. A permission revoked
 * mid-stream is therefore honoured at the next reconnect rather than instantly;
 * that is the same bargain every open page makes, and the payload is a region id
 * and a timestamp.
 *
 * **The layout guard does not run for endpoints.** `(manage)/+layout.server.ts`
 * checks the route permission map on page loads only and a `+server.ts` never
 * invokes a layout, so the checks are made here explicitly in the pipeline's
 * order: authenticate, MFA enrolment, org membership, then the permission.
 */

/** Comment frame interval, under the idle timeouts proxies default to. */
const HEARTBEAT_MS = 25_000;

/** What a client is told to wait before reconnecting. */
const RETRY_MS = 5_000;

/** ...and after being turned away. */
const BUSY_RETRY_MS = 60_000;

/**
 * How many admin fleet streams this process will hold.
 *
 * **Separate from the public cap, and deliberately not consulted against it.**
 * `MAX_CONNECTIONS` exists because an anonymous status page is an unbounded
 * resource; an authenticated admin screen is bounded by how many operators the
 * tenant employs. Turning an operator away because public viewers filled the
 * cap would refuse the fleet map at precisely the moment it is worth opening.
 *
 * It still gets a cap of its own, because `addListener` increments the same
 * process-wide counter the public cap reads: without one, admin tabs could eat
 * the public stream's headroom instead, which is the same failure wearing a
 * different hat.
 */
const MAX_FLEET_CONNECTIONS = Number(process.env.KENER_FLEET_SSE_MAX_CONNECTIONS ?? 50);

/**
 * The shortest gap between two frames about the same region, per connection.
 *
 * **The fleet map is a far coarser question than the events feeding it.**
 * `publishRegionStatus` fires on every region sample rather than only on a
 * transition, so the channel carries one event per monitor per region per
 * minute - a hundred monitors across three regions is 300 events a minute, and
 * every one of them tells this screen the same thing: that region is reporting.
 * The map's own resolution is `REGION_FRESHNESS_SECONDS`, five minutes, so
 * collapsing to one frame per region per ten seconds loses nothing observable
 * and is the difference between five frames a second and three.
 *
 * Per connection rather than per process, so one admin's throttle cannot hide a
 * region's first report from another admin who has just opened the screen.
 */
const COALESCE_MS = 10_000;

/** Open admin fleet streams in this process, for MAX_FLEET_CONNECTIONS. */
let openFleetStreams = 0;

export const GET: RequestHandler = async (event) => {
  const { cookies } = event;

  let orgId: number;
  try {
    const { user, permissions, session } = await authenticate(cookies);

    const context = {
      user,
      permissions,
      session,
      requestId: event.locals.requestId ?? crypto.randomUUID(),
      cookies,
      ip: null,
      userAgent: event.request.headers.get("user-agent"),
      orgId: session.active_org_id ?? 0,
    } as ActionContext;

    // A2b. An enrolment the instance requires is not satisfied by holding a
    // cookie, and this is not one of the enrolment screens.
    await requireMfaEnrolment("probeFleetLive", context);

    // Asserts membership and establishes the org. This is the value the stream
    // closes over, and the only thing it needs from the request.
    orgId = await requireOrg(context);

    // The same permission that opens the screen this stream feeds. `probes.read`
    // rather than `probes.write`: watching the fleet is reading it.
    if (!permissions.has("probes.read")) {
      throw new ActionError(403, "You do not have permission to view probe agents");
    }
  } catch (caught) {
    if (caught instanceof ActionError) throw error(caught.status, caught.message);
    throw error(401, "Not authorised");
  }

  const headers = {
    "content-type": "text/event-stream",
    // A proxy that gzips or rechunks an event-stream buffers it, and the whole
    // stream then arrives in one lump when the connection closes.
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // nginx buffers proxied responses by default, which defeats SSE entirely.
    "x-accel-buffering": "no",
  };

  if (openFleetStreams >= MAX_FLEET_CONNECTIONS) {
    // Accepted and closed rather than a 503: `EventSource` treats any non-200 as
    // a hard error and retries on its own schedule, ignoring `retry:`.
    return new Response(`retry: ${BUSY_RETRY_MS}\n: capacity\n\n`, { headers });
  }

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let counted = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      openFleetStreams++;
      counted = true;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client is gone and the controller is already closed. Stop
          // writing rather than throwing out of a timer callback, which would be
          // an unhandled rejection in the web process.
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
        if (counted) {
          counted = false;
          openFleetStreams--;
        }
      };

      /** When this connection last spoke about each region. See COALESCE_MS. */
      const lastSentAt = new Map<number, number>();

      send(`retry: ${RETRY_MS}\n\n`);

      // No `Last-Event-ID` replay, unlike the public stream. The fleet map is a
      // picture of the present rather than a log, the page load already supplied
      // that picture from `regionMapForFleet`, and replaying a region's report
      // from four minutes ago would move its "last seen" backwards.

      unsubscribe = addListener(orgId, (message: LiveMessage) => {
        const liveEvent = message.event;
        // The fleet asks whether a region is reporting at all, so this is the
        // only kind that carries an answer. `monitor_status` and `page_status`
        // are a different screen's business and are not forwarded - not because
        // an operator may not see them, but because sending them would invite a
        // consumer that quietly depends on this endpoint being general.
        if (liveEvent.kind !== "region_status") return;
        if (liveEvent.region_id <= 0) return;

        const now = Date.now();
        const last = lastSentAt.get(liveEvent.region_id);
        if (last !== undefined && now - last < COALESCE_MS) return;
        lastSentAt.set(liveEvent.region_id, now);

        // **Region and timestamp only, and no monitor tag.** The map draws one
        // pin per region and the per-monitor detail belongs to the public
        // monitor page; forwarding the tag would put a monitor-by-monitor feed
        // on a screen that has no way to show it and no reason to hold it.
        send(
          `event: region_report\ndata: ${JSON.stringify({
            region_id: liveEvent.region_id,
            timestamp: liveEvent.timestamp,
          })}\n\n`,
        );
      });

      // Defeats proxy idle timeouts and, just as usefully, is how this process
      // notices a client that vanished without a FIN: the enqueue throws.
      heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);
    },

    cancel() {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (counted) {
        counted = false;
        openFleetStreams--;
      }
    },
  });

  return new Response(stream, { headers });
};
