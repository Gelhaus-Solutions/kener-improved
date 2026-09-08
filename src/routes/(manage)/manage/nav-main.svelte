<script lang="ts">
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import type { Component } from "svelte";

  type NavItem = { title: string; url: string; match: string; icon?: Component };
  type NavGroup = { title: string; items: NavItem[] };

  let { groups }: { groups: NavGroup[] } = $props();

  // Per browser, not per user: which headings somebody keeps shut is a habit of
  // the machine they work on, not a property of their account, and it is not
  // worth a column and a round trip.
  const STORAGE_KEY = "kener.manage.nav.collapsed";

  let collapsed = $state<Record<string, boolean>>({});

  // Read after mount rather than during render: there is no localStorage on the
  // server, and reading it can throw outright in a browser set to block site
  // data. Every group starts open, so a read that fails leaves the sidebar in
  // its most useful state rather than an empty one.
  onMount(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) collapsed = JSON.parse(raw) ?? {};
    } catch {
      // Blocked or corrupt. Everything stays open.
    }
  });

  // `resolve()` returns a path relative to the current page ("../../manage/app/x")
  // and `page.url.pathname` is absolute, so the prefix test below used to compare
  // two different kinds of string and every entry rendered inactive, on every
  // screen. Resolving the href against the current URL fixes that and keeps
  // working under KENER_BASE_PATH.
  const absolute = (href: string) => new URL(href, page.url).pathname;

  function toggle(title: string) {
    collapsed = { ...collapsed, [title]: !collapsed[title] };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
    } catch {
      // Blocked. The toggle still works for this visit.
    }
  }
</script>

{#each groups as group (group.title)}
  {@const isCollapsed = collapsed[group.title] === true}
  <Sidebar.Group class="gap-0.5 py-0.5">
    <Sidebar.GroupLabel>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="{props.class} hover:text-sidebar-foreground h-7 w-full cursor-pointer justify-between"
          aria-expanded={!isCollapsed}
          onclick={() => toggle(group.title)}
        >
          <span class="tracking-wide uppercase">{group.title}</span>
          <ChevronDownIcon class="transition-transform duration-200 {isCollapsed ? '-rotate-90' : ''}" />
        </button>
      {/snippet}
    </Sidebar.GroupLabel>
    {#if !isCollapsed}
      <Sidebar.GroupContent>
        <Sidebar.Menu>
          {#each group.items as item (item.title)}
            <Sidebar.MenuItem>
              <Sidebar.MenuButton
                tooltipContent={item.title}
                isActive={page.url.pathname.startsWith(absolute(item.match))}
              >
                {#snippet child({ props })}
                  <a href={item.url} {...props}>
                    <item.icon />
                    <span>{item.title}</span>
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>
          {/each}
        </Sidebar.Menu>
      </Sidebar.GroupContent>
    {/if}
  </Sidebar.Group>
{/each}
