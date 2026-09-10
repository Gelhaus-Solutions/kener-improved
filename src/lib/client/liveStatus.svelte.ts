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
  /** Whether a stream is currently open. Not rendered; useful when debugging. */
  connected = $state(false);

  #source: EventSource | null = null;
  #failures = 0;
  #path: string | null = null;

  /**
   * Opens the stream for `pagePath`, or does nothing if already open for it.
   *
   * Idempotent on the path so an effect that re-runs for an unrelated reason
   * does not drop and reopen a working connection.
   */
  connect(pagePath: string): void {
    if (!browser) return;
    if (typeof EventSource === "undefined") return;
    if (this.#source && this.#path === pagePath) return;

    this.disconnect();
    this.#path = pagePath;
    this.#failures = 0;

    const url = clientResolver(resolve, "/live") + `?page=${encodeURIComponent(pagePath)}`;

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
    this.#path = null;
  }

  /** Clears every live override, for a navigation to a different page. */
  reset(): void {
    this.monitorStatusByTag = {};
    this.pageStatus = null;
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
