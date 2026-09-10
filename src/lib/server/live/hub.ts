import { redisIOConnection } from "../redisConnector.js";
import type Redis from "ioredis";

// G5: the process-local fan-out behind the public SSE stream.
//
// **One Redis subscriber per process, not per viewer.** ioredis puts a
// connection into subscriber mode exclusively - it can do nothing else once
// subscribed - so the naive shape, a `duplicate()` per open stream, would turn a
// thousand anonymous readers into a thousand Redis connections and exhaust
// `maxclients` long before anything else broke. This hub holds exactly one
// subscriber for the whole process and dispatches to local listeners in memory.
//
// **Redis pub/sub rather than an EventEmitter, and that is not a preference.**
// `npm run dev` runs the scheduler (`vite-node startup.ts`) and the web server
// (`vite dev`) as separate processes, so the transition is detected in a process
// that holds no SSE connections at all. An EventEmitter would work in production
// and silently do nothing in development, which is the worst possible failure
// mode for a feature whose whole point is that you watch it happen.

/** Everything a live event can be. Self-contained: see the note in the endpoint. */
export type LiveEvent =
  | {
      kind: "monitor_status";
      monitor_tag: string;
      status: string;
      previous_status: string | null;
      timestamp: number;
    }
  | {
      kind: "page_status";
      page_id: number;
      page_path: string;
      status: string;
      component_impact: string;
      status_summary: string;
    };

/** An event as it reaches a listener, with the id used for `Last-Event-ID`. */
export interface LiveMessage {
  id: number;
  event: LiveEvent;
}

export type LiveListener = (message: LiveMessage) => void;

/** One channel per org: a subscriber must never see another tenant's traffic. */
export function channelFor(orgId: number): string {
  return `kener:live:${orgId}`;
}

/** The per-org sequence counter, so ids are ordered across every web process. */
export function sequenceKeyFor(orgId: number): string {
  return `kener:live:seq:${orgId}`;
}

/**
 * How many recent events are kept per org for `Last-Event-ID` replay.
 *
 * **Per process, and deliberately not more than that.** Redis pub/sub keeps no
 * history, so a true cross-process replay would need a stream and a retention
 * policy - real work for a feature whose job is to save a page reload. A
 * reconnect that lands on the same process replays exactly; one that lands
 * elsewhere replays nothing and the client simply has slightly stale bars until
 * the next transition. Never wrong, occasionally less complete.
 */
const REPLAY_BUFFER = 100;

/**
 * How long an org's buffer and subscription outlive its last listener.
 *
 * **Without this, the replay buffer is destroyed by the exact event it exists to
 * survive.** Tearing down on the last disconnect meant a page with one viewer -
 * the normal case for a small status page - unsubscribed from Redis the moment
 * that viewer's connection dropped, buffered nothing while they were away, and
 * had nothing to replay when they came back. `Last-Event-ID` was implemented and
 * could never once have fired.
 *
 * Five minutes covers a proxy idle timeout, a laptop lid, a phone changing
 * network - the reconnects this is for - while still releasing an org nobody is
 * watching. The cost of holding it is one Redis subscription and at most a
 * hundred small objects.
 */
const RETAIN_AFTER_LAST_LISTENER_MS = 5 * 60_000;

interface OrgState {
  listeners: Set<LiveListener>;
  recent: LiveMessage[];
  /** Pending teardown, cancelled if a listener returns in time. */
  retire: ReturnType<typeof setTimeout> | null;
}

const byOrg = new Map<number, OrgState>();
let subscriber: Redis | null = null;
/** Total open SSE streams in this process, for the connection cap. */
let openConnections = 0;

function getSubscriber(): Redis {
  if (subscriber) return subscriber;
  // `duplicate()` rather than a second `new Redis(...)`: it inherits the
  // configured retry and keepalive behaviour instead of quietly diverging.
  subscriber = redisIOConnection().duplicate();

  subscriber.on("message", (channel: string, raw: string) => {
    const match = channel.match(/^kener:live:(\d+)$/);
    if (!match) return;
    const orgId = Number(match[1]);
    const state = byOrg.get(orgId);
    if (!state) return;

    let message: LiveMessage;
    try {
      message = JSON.parse(raw) as LiveMessage;
    } catch {
      // A malformed payload is a bug on the publish side; dropping it keeps
      // every open stream alive rather than tearing them down over one message.
      return;
    }

    state.recent.push(message);
    if (state.recent.length > REPLAY_BUFFER) state.recent.shift();

    for (const listener of state.listeners) {
      try {
        listener(message);
      } catch {
        // One stream failing to write must not stop the others being told.
      }
    }
  });

  subscriber.on("error", (error: Error) => {
    // Logged and swallowed: ioredis reconnects on its own, and an unhandled
    // error here would take down the web process over a status-page nicety.
    console.warn("live hub: redis subscriber error:", error.message);
  });

  return subscriber;
}

/** Open streams right now, for the cap and for diagnostics. */
export function connectionCount(): number {
  return openConnections;
}

/**
 * Registers `listener` for `orgId` and returns the unsubscribe.
 *
 * Subscribing to the Redis channel happens on the first listener for an org and
 * unsubscribing on the last, so an instance serving one tenant holds one
 * subscription rather than one per page.
 */
export function addListener(orgId: number, listener: LiveListener): () => void {
  let state = byOrg.get(orgId);
  if (!state) {
    state = { listeners: new Set(), recent: [], retire: null };
    byOrg.set(orgId, state);
    void getSubscriber()
      .subscribe(channelFor(orgId))
      .catch((error: Error) => console.warn(`live hub: could not subscribe to org ${orgId}:`, error.message));
  }
  // A listener arriving during the retention window keeps everything alive, and
  // - the point of the whole mechanism - keeps the buffer it is about to replay.
  if (state.retire) {
    clearTimeout(state.retire);
    state.retire = null;
  }
  state.listeners.add(listener);
  openConnections++;

  let released = false;
  return () => {
    // Guarded: a stream can be torn down by both `cancel` and its own error
    // path, and decrementing twice would leak capacity out of the cap.
    if (released) return;
    released = true;
    openConnections--;

    const current = byOrg.get(orgId);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;

    // Retained rather than dropped: see RETAIN_AFTER_LAST_LISTENER_MS.
    if (current.retire) clearTimeout(current.retire);
    current.retire = setTimeout(() => {
      const latest = byOrg.get(orgId);
      // Re-checked, because a listener may have arrived and left again between
      // the timer being set and it firing.
      if (!latest || latest.listeners.size > 0) return;
      byOrg.delete(orgId);
      void getSubscriber()
        .unsubscribe(channelFor(orgId))
        .catch(() => {
          /* unsubscribing a dead connection is not worth reporting */
        });
    }, RETAIN_AFTER_LAST_LISTENER_MS);
    // Node must not stay alive purely to hold an idle status-page buffer.
    current.retire.unref?.();
  };
}

/** Buffered events newer than `afterId`, for `Last-Event-ID` resume. */
export function replaySince(orgId: number, afterId: number): LiveMessage[] {
  const state = byOrg.get(orgId);
  if (!state) return [];
  return state.recent.filter((m) => m.id > afterId);
}

/** Closes the subscriber. Called from the queue shutdown path. */
export async function shutdownLiveHub(): Promise<void> {
  for (const state of byOrg.values()) {
    if (state.retire) clearTimeout(state.retire);
  }
  byOrg.clear();
  openConnections = 0;
  if (subscriber) {
    await subscriber.quit().catch(() => {
      /* already gone */
    });
    subscriber = null;
  }
}
