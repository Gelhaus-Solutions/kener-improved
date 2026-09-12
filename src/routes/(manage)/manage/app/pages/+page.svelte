<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import * as Table from "$lib/components/ui/table/index.js";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import Plus from "@lucide/svelte/icons/plus";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import * as Item from "$lib/components/ui/item/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import PageStatusExplainer from "$lib/components/manage/PageStatusExplainer.svelte";
  import HelpCircleIcon from "@lucide/svelte/icons/circle-help";
  import type { PageExplanation } from "$lib/server/incidents/explain.js";
  import type { PageRecord } from "$lib/server/types/db.js";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";

  interface PageWithMonitors extends PageRecord {
    monitors?: { monitor_tag: string }[];
  }

  let pages = $state<PageWithMonitors[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function fetchPages() {
    loading = true;
    error = null;
    try {
      const response = await fetch(clientResolver(resolve, "/manage/api"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "getPages" })
      });
      const result = await response.json();
      if (result.error) {
        error = result.error;
      } else {
        pages = result;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to fetch pages";
    } finally {
      loading = false;
    }
  }

  /**
   * "Why is this page not green", answered where it is asked.
   *
   * `ComponentStatus.source` has recorded which rule decided each component
   * since C2b and nothing ever showed it, so the answer lived in the database
   * and took four rounds of psql to assemble.
   */
  let explaining = $state<PageWithMonitors | null>(null);
  let explanation = $state<(PageExplanation & { page_name: string }) | null>(null);
  let explainLoading = $state(false);
  let explainError = $state<string | null>(null);

  async function explain(page: PageWithMonitors) {
    explaining = page;
    explanation = null;
    explainError = null;
    explainLoading = true;
    try {
      const response = await fetch(clientResolver(resolve, "/manage/api"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "explainPageStatus", data: { page_id: page.id } })
      });
      const result = await response.json();
      if (result.error) explainError = result.error;
      else explanation = result;
    } catch (e) {
      explainError = e instanceof Error ? e.message : "Could not explain this page";
    } finally {
      explainLoading = false;
    }
  }

  onMount(() => {
    fetchPages();
  });
</script>

<div class="flex w-full flex-col gap-4 p-4">
  <!-- Header -->
  <div class="mb-4 flex justify-end">
    <Button class="cursor-pointer" onclick={() => goto(clientResolver(resolve, "/manage/app/pages/new"))}>
      <Plus class="size-4" />
      New Page
    </Button>
  </div>

  {#if loading}
    <div class="flex w-full flex-col gap-4 [--radius:1rem]">
      <Item.Root variant="muted" class="mx-auto">
        <Item.Media>
          <Spinner />
        </Item.Media>
        <Item.Content>
          <Item.Title class="line-clamp-1">Loading Pages....</Item.Title>
        </Item.Content>
      </Item.Root>
    </div>
  {:else if error}
    <div class="text-destructive py-8 text-center">
      {error}
    </div>
  {:else if pages.length === 0}
    <div class="text-muted-foreground py-8 text-center">No pages found. Create your first page to get started.</div>
  {:else}
    <div class="ktable rounded-xl border">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head class="w-[340px]">Page</Table.Head>
            <Table.Head class="w-[220px]">Path</Table.Head>
            <Table.Head class="w-[150px]">Monitors</Table.Head>
            <Table.Head class="w-[120px] text-right"></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each pages as page (page.id)}
            <Table.Row>
              <Table.Cell>
                <div class="flex items-start gap-3">
                  <Avatar.Root class="size-8 rounded-sm">
                    {#if page.page_logo}
                      <Avatar.Image src={clientResolver(resolve, page.page_logo)} alt={page.page_title} />
                    {/if}
                    <Avatar.Fallback>
                      {page.page_title.charAt(0).toUpperCase()}
                    </Avatar.Fallback>
                  </Avatar.Root>
                  <div class="min-w-0">
                    <div class="font-medium">{page.page_title}</div>
                    <p class="text-muted-foreground line-clamp-2 text-xs">{page.page_header}</p>
                  </div>
                </div>
              </Table.Cell>
              <Table.Cell>
                <Button
                  variant="link"
                  class="h-auto px-0"
                  href={clientResolver(resolve, `/${page.page_path}`)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  /{page.page_path}
                </Button>
              </Table.Cell>
              <Table.Cell>
                {#if page.monitors && page.monitors.length > 0}
                  <Badge variant="secondary">{page.monitors.length} monitor{page.monitors.length > 1 ? "s" : ""}</Badge>
                {:else}
                  <Badge variant="outline" class="text-muted-foreground">No monitors</Badge>
                {/if}
              </Table.Cell>

              <Table.Cell class="text-right">
                <Button variant="ghost" size="sm" onclick={() => explain(page)} title="Why is this page not green?">
                  <HelpCircleIcon class="size-4" />
                  Why
                </Button>
                <Button variant="ghost" target="_blank" size="sm" href={clientResolver(resolve, `/${page.page_path}`)}>
                  View
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onclick={() => goto(clientResolver(resolve, `/manage/app/pages/${page.id}`))}
                >
                  Edit
                </Button>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {/if}
</div>

<Dialog.Root open={explaining !== null} onOpenChange={(open) => (explaining = open ? explaining : null)}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Why {explaining?.page_title} says what it says</Dialog.Title>
      <Dialog.Description>
        Derived now, by the same code the public page runs. Each component shows which rule decided it and the evidence
        behind that rule.
      </Dialog.Description>
    </Dialog.Header>
    <PageStatusExplainer {explanation} loading={explainLoading} error={explainError} />
  </Dialog.Content>
</Dialog.Root>
