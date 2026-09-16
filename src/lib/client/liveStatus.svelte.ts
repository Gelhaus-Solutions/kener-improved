import { browser } from "$app/environment";
import { resolve } from "$app/paths";
import clientResolver from "$lib/client/resolver.js";
import type { StatusType } from "$lib/types/status";

// G5, the browser half: one `EventSource` per page, and the state it produces.
//
// **Degrades to exactly today's behaviour, never to something worse.** The item
// asked for a fallback to "the existing polling", but there is no existing
// polling: the bars are fetched once on mount and never refreshed. So there is
// nothing to fall back *to*, and adding a poll would mean inventing a new
// standing cost for every anonymous visitor in order to hedge a feature that is
// itself an optimisation. If the stream never connects, the page behaves exactly
// as it shipped before G5 - fetched once, accurate at load.

export interface LivePageStatus {
  status: string;
  component_impact: string;
  status_summary: string;
}

/**
 * Reconnects tolerated before giving up for the life of the page.
 *
 * `EventSource` retries forever by default. That is right for a blip and wrong
 * for an instance that is refusing connections, where a few thousand open tabs
 * retrying forever is a load source rather than a nicety. The server sends a
 * long `retry:` when it turns a client away; this is the belt to that braces.
 */
const MAX_FAILURES = 10;

class LiveStatus {
  /** Live status per monitor tag, overriding what was fetched at load. */
  monitorStatusByTag = $state<Record<string, StatusType>>({});
  /** The page's overall status, once it has changed at least once. */
  pageStatus = $state<LivePageStatus | null>(null);
  /**
   * B13. The latest per-region sample, keyed `<monitor_tag>:<region_id>`.
   *
   * A composite string key rather than a nested record because `$state`
   * reactivity is per assignment: one flat object replaced wholesale makes every
   * `$derived` over it recompute, while mutating an inner object would not.
   */
  regionStatusByKey = $state<Record<string, { status: string; latency: number | null; timestamp: number }>>({});
  /** Whether a stream is currently open. Not rendered; useful when debugging. */
  connected = $state(false);

  #source: EventSource | null = null;
  #failures = 0;
  #scope: string | null = null;

  /**
   * Opens the stream for `pagePath`, or does nothing if already open for it.
   *
   * Idempotent on the scope so an effect that re-runs for an unrelated reason
   * does not drop and reopen a working connection.
   */
  connect(pagePath: string): void {
    this.#open(`page:${pagePath}`, `page=${encodeURIComponent(pagePath)}`);
  }

  /**
   * B13. Opens the stream for one monitor, for `/monitors/<slug>`.
   *
   * **A monitor page is not a page**, and calling `connect` there was the bug
   * this method exists to make impossible: `?page=` resolves a status page's
   * monitor list, `/monitors/<slug>` is not in that table, and the default
   * therefore hands the monitor page the HOME page's allowlist - allowing
   * whatever is listed there and refusing the monitor actually on screen.
   *
   * The argument is the name in the URL, which is the per-org SLUG. The server
   * resolves it to the physical tag and every event still arrives keyed by tag,
   * so callers must not try to be helpful and translate it first.
   */
  connectMonitor(monitorName: string): void {
    this.#open(`monitor:${monitorName}`, `monitor=${encodeURIComponent(monitorName)}`);
  }

  /**
   * The shared body of both scopes.
   *
   * `scopeKey` is prefixed by kind rather than being the bare name, so a page at
   * path "api" and a monitor with slug "api" are not mistaken for the same open
   * stream - which would leave whichever connected second reading the first
   * one's allowlist.
   */
  #open(scopeKey: string, query: string): void {
    if (!browser) return;
    if (typeof EventSource === "undefined") return;
    if (this.#source && this.#scope === scopeKey) return;

    this.disconnect();
    this.#scope = scopeKey;
    this.#failures = 0;

    const url = clientResolver(resolve, "/live") + `?${query}`;

    let source: EventSource;
    try {
      source = new EventSource(url);
    } catch {
      // Nothing to report and nothing to retry: the page is already correct.
      return;
    }
    this.#source = source;

    source.addEventListener("open", () => {
      this.connected = true;
      // A successful open clears the budget: a page open for a week through a
      // flaky network should not eventually exhaust it and stop updating.
      this.#failures = 0;
    });

    source.addEventListener("monitor_status", (event) => {
      const data = this.#parse(event);
      if (!data || typeof data.monitor_tag !== "string" || typeof data.status !== "string") return;
      // A new object, not a mutation: this is `$state`, and replacing the record
      // is what makes every `$derived` over it recompute.
      this.monitorStatusByTag = {
        ...this.monitorStatusByTag,
        [data.monitor_tag]: data.status as StatusType,
      };
    });

    source.addEventListener("page_status", (event) => {
      const data = this.#parse(event);
      if (!data || typeof data.status !== "string") return;
      this.pageStatus = {
        status: data.status,
        component_impact: String(data.component_impact ?? ""),
        status_summary: String(data.status_summary ?? ""),
      };
    });

    source.addEventListener("region_status", (event) => {
      const data = this.#parse(event);
      if (!data || typeof data.monitor_tag !== "string" || typeof data.status !== "string") return;
      if (typeof data.region_id !== "number" || typeof data.timestamp !== "number") return;
      // Region 0 is the merged verdict and arrives as `monitor_status`. Guarded
      // here as well as on the server so a stray event can never put the verdict
      // on the map as though it were a place.
      if (data.region_id <= 0) return;

      this.regionStatusByKey = {
        ...this.regionStatusByKey,
        [`${data.monitor_tag}:${data.region_id}`]: {
          status: data.status,
          latency: typeof data.latency === "number" ? data.latency : null,
          timestamp: data.timestamp,
        },
      };
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
    this.#scope = null;
  }

  /** Clears every live override, for a navigation to a different page. */
  reset(): void {
    this.monitorStatusByTag = {};
    this.pageStatus = null;
    this.regionStatusByKey = {};
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

/**
 * One connection per tab, shared by the list and the page header.
 *
 * A singleton because the two consumers render in different components and both
 * need the same stream; two `EventSource`s to the same endpoint would double the
 * server's per-viewer cost to show the same thing twice.
 */
export const liveStatus = new LiveStatus();
