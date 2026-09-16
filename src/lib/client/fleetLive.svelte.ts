import { browser } from "$app/environment";
import { resolve } from "$app/paths";
import clientResolver from "$lib/client/resolver.js";

// B13, the admin half: the probes screen's fleet map, kept live.
//
// **Deliberately not `liveStatus`.** That store is the public page's, it is a
// singleton holding a public scope, and it opens `(kener)/live` - an anonymous
// endpoint an operator would have to be scoped into some status page to use.
// The two also want different things: the public map asks what a region is
// SEEING, and this one asks whether a region is REPORTING AT ALL. Sharing a
// store would mean one object whose contents depend on which screen last
// connected.
//
// Degrades to exactly the behaviour it replaces: the screen loads a map built by
// `regionMapForFleet` and, if the stream never connects, that map stays correct
// at load and goes stale visibly, because freshness is re-evaluated on a timer
// rather than frozen at load.

/**
 * Reconnects tolerated before giving up for the life of the page.
 *
 * `EventSource` retries forever by default, which is right for a blip and wrong
 * for an instance refusing connections. The server sends a long `retry:` when it
 * turns a client away; this is the belt to that braces.
 */
const MAX_FAILURES = 10;

class FleetLive {
  /**
   * The newest report seen per region id, in UTC seconds.
   *
   * Keyed by region rather than by monitor because that is the whole question
   * this screen asks. The endpoint coalesces per region for the same reason, so
   * this record is written a few times a minute rather than a few times a
   * second.
   */
  reportedAt = $state<Record<number, number>>({});
  /** Whether a stream is currently open. */
  connected = $state(false);

  #source: EventSource | null = null;
  #failures = 0;

  /** Opens the stream, or does nothing if one is already open. */
  connect(): void {
    if (!browser) return;
    if (typeof EventSource === "undefined") return;
    if (this.#source) return;

    this.#failures = 0;

    let source: EventSource;
    try {
      source = new EventSource(clientResolver(resolve, "/manage/app/probes/live"));
    } catch {
      // Nothing to report and nothing to retry: the screen is already correct.
      return;
    }
    this.#source = source;

    source.addEventListener("open", () => {
      this.connected = true;
      // A successful open clears the budget, so a screen left open through a
      // flaky network does not eventually exhaust it and stop updating.
      this.#failures = 0;
    });

    source.addEventListener("region_report", (event) => {
      const data = this.#parse(event);
      if (!data) return;
      if (typeof data.region_id !== "number" || typeof data.timestamp !== "number") return;
      // Reserved ids are not places and are never plotted. Guarded here as well
      // as on the server, because a store is easier to reuse than to re-read.
      if (data.region_id <= 0) return;

      const previous = this.reportedAt[data.region_id];
      // **Never moves a region's last-seen backwards.** Events can arrive out of
      // order across a reconnect, and an older timestamp overwriting a newer one
      // would age a healthy region towards NO_DATA on a screen that is watching
      // it report perfectly well.
      if (previous !== undefined && previous >= data.timestamp) return;

      // A new object, not a mutation: this is `$state`, and replacing the record
      // is what makes the `$derived` over it recompute.
      this.reportedAt = { ...this.reportedAt, [data.region_id]: data.timestamp };
    });

    source.addEventListener("error", () => {
      this.connected = false;
      this.#failures++;
      if (this.#failures >= MAX_FAILURES) this.disconnect();
    });
  }

  disconnect(): void {
    if (this.#source) {
      this.#source.close();
      this.#source = null;
    }
    this.connected = false;
  }

  /** Clears every live override, for a screen being left and returned to. */
  reset(): void {
    this.reportedAt = {};
  }

  #parse(event: Event): Record<string, unknown> | null {
    const messageEvent = event as MessageEvent<string>;
    try {
      const parsed = JSON.parse(messageEvent.data) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

/** One connection per tab. Only the probes screen consumes it. */
export const fleetLive = new FleetLive();
