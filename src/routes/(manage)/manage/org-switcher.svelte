<script lang="ts">
  import Building2Icon from "@lucide/svelte/icons/building-2";
  import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
  import CheckIcon from "@lucide/svelte/icons/check";
  import LoaderIcon from "@lucide/svelte/icons/loader";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import { canReachRoute, routeIdForManageUrl } from "$lib/routePermissions.js";
  import { toast } from "svelte-sonner";

  // Every screen the switcher could land on, in sidebar order. `section` is the
  // path that says which entry the current URL belongs to; `urls` are the tabs
  // under it, each of which has its own route id and its own permission.
  type NavTarget = { section: string; urls: string[] };

  let { targets }: { targets: NavTarget[] } = $props();

  type Org = { id: number; slug: string; name: string; is_owner: boolean; is_default: boolean };

  let orgs = $derived((page.data.orgs ?? []) as Org[]);
  let activeOrgId = $derived(page.data.activeOrgId as number);
  let canCreateOrg = $derived(page.data.canCreateOrg as boolean);
  let current = $derived(orgs.find((org) => org.id === activeOrgId));

  // Hidden outright for the single-org install this is invisible to, which is
  // almost all of them. The exception is somebody who could create a second org:
  // hiding it from them too would leave no way to reach the screen that does it.
  let visible = $derived(orgs.length > 1 || canCreateOrg);

  const ORGS_URL = "/manage/app/organisations";

  let canManageOrgs = $derived(canReachRoute(page.data.userPermissions, routeIdForManageUrl(ORGS_URL)));

  let switching = $state<number | null>(null);

  const sidebar = Sidebar.useSidebar();

  /**
   * Where to land after switching.
   *
   * Roles are per-org, so the screen being looked at may not be reachable in the
   * org being moved to, and a switch that dumps somebody on a Forbidden page is
   * worse than one that moves them. The section is preferred over the exact URL
   * on purpose: a deep link carries ids that belong to the org being left, and
   * `/manage/app/monitors/5` means a different monitor - or none - over there.
   */
  function landingFor(permissions: string[]): string {
    const absolute = (url: string) => new URL(clientResolver(resolve, url), page.url).pathname;
    const reachable = (url: string) => canReachRoute(permissions, routeIdForManageUrl(url));

    const section = targets
      .filter((target) => page.url.pathname.startsWith(absolute(target.section)))
      .sort((a, b) => absolute(b.section).length - absolute(a.section).length)[0];

    const preferred = section?.urls.find(reachable);
    if (preferred) return clientResolver(resolve, preferred);

    for (const target of targets) {
      const url = target.urls.find(reachable);
      if (url) return clientResolver(resolve, url);
    }

    // Nothing at all is reachable over there. Going anyway is the honest answer:
    // the layout says Forbidden, which is exactly what the situation is.
    return clientResolver(resolve, targets[0]?.urls[0] ?? ORGS_URL);
  }

  async function switchTo(orgId: number) {
    if (orgId === activeOrgId || switching !== null) return;
    switching = orgId;
    try {
      const response = await fetch(clientResolver(resolve, "/manage/api"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "switchOrg", data: { org_id: orgId } })
      });
      const body = await response.json();
      if (!response.ok || body?.error) throw new Error(body?.error || "Could not switch organisation");

      // A full load rather than `goto`: the org decides the permissions, the site
      // data, the theme and every row on every screen, so there is nothing on the
      // client worth keeping and a stale piece of it would be a tenant's data
      // shown under another tenant's name.
      window.location.href = landingFor(body.permissions ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not switch organisation");
      switching = null;
    }
  }
</script>

{#if visible}
  <Sidebar.Menu>
    <Sidebar.MenuItem>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Sidebar.MenuButton
              {...props}
              size="lg"
              class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div
                class="bg-sidebar-accent text-sidebar-accent-foreground flex size-8 items-center justify-center rounded-lg"
              >
                <Building2Icon class="size-4" />
              </div>
              <div class="grid flex-1 text-start text-sm leading-tight">
                <span class="text-muted-foreground text-xs">Organisation</span>
                <span class="truncate font-medium">{current?.name ?? "Unknown"}</span>
              </div>
              <ChevronsUpDownIcon class="ms-auto size-4" />
            </Sidebar.MenuButton>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          class="w-(--bits-dropdown-menu-anchor-width) min-w-56 rounded-lg"
          side={sidebar.isMobile ? "bottom" : "right"}
          align="start"
          sideOffset={4}
        >
          <DropdownMenu.Label class="text-muted-foreground text-xs">Your organisations</DropdownMenu.Label>
          <DropdownMenu.Group>
            {#each orgs as org (org.id)}
              <DropdownMenu.Item class="gap-2" disabled={switching !== null} onclick={() => switchTo(org.id)}>
                {#if switching === org.id}
                  <LoaderIcon class="size-4 animate-spin" />
                {:else if org.id === activeOrgId}
                  <CheckIcon class="size-4" />
                {:else}
                  <span class="size-4"></span>
                {/if}
                <span class="truncate">{org.name}</span>
                <span class="text-muted-foreground ms-auto text-xs">{org.slug}</span>
              </DropdownMenu.Item>
            {/each}
          </DropdownMenu.Group>
          {#if canManageOrgs}
            <DropdownMenu.Separator />
            <DropdownMenu.Item>
              {#snippet child({ props })}
                <a href={clientResolver(resolve, ORGS_URL)} {...props} class="{props.class} gap-2">
                  <SettingsIcon class="size-4" />
                  Manage organisations
                </a>
              {/snippet}
            </DropdownMenu.Item>
          {/if}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </Sidebar.MenuItem>
  </Sidebar.Menu>
{/if}
