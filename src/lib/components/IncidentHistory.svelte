<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import IncidentItem from "$lib/components/IncidentItem.svelte";
  import SearchIcon from "@lucide/svelte/icons/search";
  import XIcon from "@lucide/svelte/icons/x";
  import { t } from "$lib/stores/i18n";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { browser } from "$app/environment";
  import clientResolver from "$lib/client/resolver.js";
  import trackEvent from "$lib/beacon";
  import type { IncidentForMonitorListWithComments } from "$lib/server/types/db";

  // G7: the searchable, keyset-paged public incident history.
  //
  // **One component, rendered by both routes.** `(kener)/history` and
  // `(kener)/[page_path]/history` are thin wrappers around this, for the reason
  // `MonitorList` exists: the two public page components were near-copies and a
  // feature added to one silently did nothing on the other.
  //
  // **Paging is cursor-based, so "load more" cannot duplicate a row.** Offset
  // paging over a newest-first list shifts every later row down when an incident
  // is created mid-browse, and the reader sees something they already read. The
  // cursor is opaque here on purpose: it is the server's description of a
  // position, and this component only ever hands it back.

  interface Props {
    /** The page whose history this is; "" for the home page. */
    pagePath: string;
  }

  let { pagePath }: Props = $props();

  interface HistoryResponse {
    incidents: IncidentForMonitorListWithComments[];
    nextCursor: string | null;
  }

  let incidents = $state<IncidentForMonitorListWithComments[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let failed = $state(false);

  // Seeded from the URL so a search is shareable, which is the point of putting
  // it there: during a postmortem somebody wants to send "every incident
  // mentioning this", not "open this and type".
  let searchTerm = $state(page.url.searchParams.get("q") ?? "");
  /** What the last request actually asked for, so typing does not race the results. */
  let activeTerm = $state(page.url.searchParams.get("q") ?? "");

  let requestVersion = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  function endpoint(cursor: string | null): string {
    const params = new URLSearchParams();
    if (pagePath) params.set("page_path", pagePath);
    if (activeTerm) params.set("q", activeTerm);
    if (cursor) params.set("cursor", cursor);
    return clientResolver(resolve, "/dashboard-apis/incident-history") + `?${params.toString()}`;
  }

  async function load(reset: boolean) {
    const version = ++requestVersion;
    if (reset) {
      loading = true;
      failed = false;
    } else {
      loadingMore = true;
    }

    try {
      const response = await fetch(endpoint(reset ? null : nextCursor));
      if (!response.ok) throw new Error(`history request failed: ${response.status}`);
      const payload = (await response.json()) as HistoryResponse;

      // A slower earlier request must not overwrite a newer one's results, which
      // is exactly what happens when someone types quickly.
      if (version !== requestVersion) return;

      incidents = reset ? payload.incidents : [...incidents, ...payload.incidents];
      nextCursor = payload.nextCursor;
    } catch {
      if (version !== requestVersion) return;
      failed = true;
      if (reset) incidents = [];
    } finally {
      if (version === requestVersion) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  function applySearch(term: string) {
    activeTerm = term;
    nextCursor = null;

    if (browser) {
      const next = new URL(page.url);
      if (term) next.searchParams.set("q", term);
      else next.searchParams.delete("q");
      // `replaceState`: a search is a view of this page, not a place. Pushing
      // would make the back button walk through every keystroke.
      if (next.href !== page.url.href) replaceState(next, page.state);
    }

    if (term) trackEvent("incident_history_searched", { length: String(term.length) });
    void load(true);
  }

  function onInput() {
    clearTimeout(debounce);
    // Long enough that typing a word is one request, short enough to feel live.
    debounce = setTimeout(() => applySearch(searchTerm.trim()), 300);
  }

  function clearSearch() {
    clearTimeout(debounce);
    searchTerm = "";
    applySearch("");
  }

  $effect(() => {
    // Re-runs when the page being viewed changes, which is a different history.
    void pagePath;
    void load(true);
  });
</script>

<div class="flex flex-col gap-4">
  <div class="relative">
    <SearchIcon class="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
    <Input
      type="search"
      bind:value={searchTerm}
      oninput={onInput}
      placeholder={$t("Search incidents")}
      aria-label={$t("Search incidents")}
      class="rounded-full pr-10 pl-9"
    />
    {#if searchTerm}
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
        aria-label={$t("Clear search")}
        onclick={clearSearch}
      >
        <XIcon class="h-4 w-4" />
      </button>
    {/if}
  </div>

  {#if loading}
    <div class="flex justify-center py-10">
      <Spinner class="h-5 w-5" />
    </div>
  {:else if failed}
    <div class="text-muted-foreground rounded-3xl border px-4 py-8 text-center text-sm">
      {$t("Could not load incident history")}
    </div>
  {:else if incidents.length === 0}
    <div class="text-muted-foreground rounded-3xl border px-4 py-8 text-center text-sm">
      {#if activeTerm}
        {$t("No incidents match your search")}
      {:else}
        {$t("No incidents to show")}
      {/if}
    </div>
  {:else}
    <div class="flex flex-col gap-3">
      {#each incidents as incident (incident.id)}
        <div class="rounded-3xl border p-3 sm:p-4">
          <IncidentItem {incident} />
        </div>
      {/each}
    </div>

    {#if nextCursor}
      <div class="flex justify-center pt-2">
        <Button variant="outline" size="sm" class="rounded-full" disabled={loadingMore} onclick={() => load(false)}>
          {#if loadingMore}
            <Spinner class="mr-2 h-4 w-4" />
          {/if}
          {$t("Load more")}
        </Button>
      </div>
    {/if}
  {/if}
</div>
