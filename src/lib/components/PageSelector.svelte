<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import type { PageNavItem } from "$lib/server/controllers/dashboardController.js";
  import { page } from "$app/state";

  // G3: the public page switcher.
  //
  // **Reads the list from layout data rather than fetching it.** This used to
  // call `/dashboard-apis/pages` in `onMount`, which meant every visitor to every
  // status page paid an extra round trip, and saw a spinner where the page name
  // belongs, for a list the server already had while rendering. The list now
  // comes from `GetLayoutServerData` - cached by I1, so it costs nothing per
  // request - and the switcher server-renders with the current page already
  // selected instead of appearing a moment later.
  //
  // The org scoping the item asks for is not done here and could not be: the
  // list is resolved server-side through `BaseRepository.table()`, under the org
  // that `orgResolveHandle` established from the hostname.

  // G4. On a hostname bound to a page, the site root *is* that page, so the
  // current entry is the bound one rather than the empty home path.
  const currentPath = $derived(page.params.page_path ?? page.data.boundPagePath ?? "");
  const pages = $derived<PageNavItem[]>(page.data.switcherPages ?? []);

  /**
   * Where a switcher entry points.
   *
   * G4's constraint on G3: a page that lives on its own domain must be linked to
   * absolutely. A relative path would resolve against whichever domain the
   * visitor is currently on, and on a bound host that path either 404s or serves
   * a different page entirely.
   */
  function hrefFor(item: PageNavItem): string {
    if (item.primary_hostname) {
      const scheme = typeof window !== "undefined" ? window.location.protocol : "https:";
      return `${scheme}//${item.primary_hostname}`;
    }
    return clientResolver(resolve, `/${item.page_path}`);
  }

  const currentPage = $derived(pages.find((p) => p.page_path === currentPath) ?? pages.find((p) => p.page_path === ""));

  /**
   * One page is not a choice.
   *
   * A switcher offering only the page you are already on is a control that
   * cannot do anything, and it costs the same header space as a useful one.
   */
  const hasChoice = $derived(pages.length > 1);
</script>

{#if hasChoice}
  <div class="flex shrink-0 items-center gap-2">
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="outline"
            size="sm"
            class="bg-background/80 dark:bg-background/70 border-foreground/10 flex items-center justify-center rounded-full border text-xs shadow-none backdrop-blur-md"
          >
            <span class="hidden max-w-[16rem] truncate sm:inline">{currentPage?.page_title || "Home"}</span>
            <span class="sr-only sm:hidden">{currentPage?.page_title || "Home"}</span>
            <ChevronDown class="h-4 w-4" />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        align="start"
        class="bg-background/30 supports-backdrop-filter:bg-background/20 flex flex-col gap-1 rounded-3xl border p-2 shadow-2xl backdrop-blur-2xl"
      >
        {#each pages as item (item.page_path)}
          <Button
            variant={item.page_path === currentPath ? "outline" : "ghost"}
            size="sm"
            href={hrefFor(item)}
            class="w-full justify-start rounded-full text-xs shadow-none"
          >
            {item.page_title}
          </Button>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
{/if}
