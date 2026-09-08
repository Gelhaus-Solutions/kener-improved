<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import { cn } from "$lib/utils.js";

  // A screen that used to be several sidebar entries renders one of these
  // instead. The tabs are real links to real routes, not a `Tabs` component:
  // each tab keeps its own route id, so it keeps its own entry in the route
  // permission map and stays deep-linkable and bookmarkable.
  let { tabs }: { tabs: { title: string; url: string }[] } = $props();

  let resolved = $derived(tabs.map((tab) => ({ ...tab, href: clientResolver(resolve, tab.url) })));

  // `resolve()` returns a path relative to the current page ("../../manage/app/x"),
  // while `page.url.pathname` is absolute, so the two cannot be compared as they
  // stand. Resolving the href against the current URL puts both on the same
  // footing, and does the right thing under KENER_BASE_PATH: the number of
  // leading `../` already accounts for the depth of the page doing the linking.
  const absolute = (href: string) => new URL(href, page.url).pathname;

  // Exact match, not `startsWith`: the first tab is the section's index route,
  // and every other tab lives underneath it, so a prefix test would light up
  // the first tab on every page of the section.
  const normalise = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
  let current = $derived(normalise(page.url.pathname));
</script>

{#if resolved.length > 1}
  <nav class="border-border flex flex-wrap items-center gap-1 border-b px-4 pt-2" aria-label="Section">
    {#each resolved as tab (tab.url)}
      {@const active = current === normalise(absolute(tab.href))}
      <a
        href={tab.href}
        aria-current={active ? "page" : undefined}
        class={cn(
          "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
          active
            ? "border-foreground text-foreground"
            : "text-muted-foreground hover:text-foreground border-transparent"
        )}
      >
        {tab.title}
      </a>
    {/each}
  </nav>
{/if}
