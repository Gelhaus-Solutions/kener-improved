<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import TrashIcon from "@lucide/svelte/icons/trash";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import { toast } from "svelte-sonner";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import { onMount } from "svelte";

  // Categories are the sections a status page shows when its Component Grouping
  // is set to "Group by category". A category is not a row anywhere: it is a
  // distinct value of `monitors.category_name`, so this screen edits monitors and
  // the list of categories falls out of what they hold.
  //
  // That is why there is no "create an empty category" button. A category with no
  // components in it would exist only in this screen's memory, vanish on reload
  // and never appear on a page - so a new category is made by putting a component
  // in one, which is the same action as moving a component between two.

  interface CategoryMonitor {
    tag: string;
    slug: string;
    name: string;
    status: string;
    is_hidden: string;
  }
  interface Category {
    name: string | null;
    monitors: CategoryMonitor[];
  }

  let categories = $state<Category[]>([]);
  let uncategorised = $state<Category>({ name: null, monitors: [] });
  let loading = $state(true);
  let error = $state<string | null>(null);

  let renaming = $state<string | null>(null);
  let renameTo = $state("");
  let moving = $state<CategoryMonitor | null>(null);
  let moveTo = $state("");
  let busy = $state(false);

  /** Every category name currently in use, offered as shortcuts in the move dialog. */
  let categoryNames = $derived(categories.map((category) => category.name).filter((name): name is string => !!name));

  /** Every section that has components, uncategorised last, which is where a page puts it. */
  let sections = $derived(uncategorised.monitors.length > 0 ? [...categories, uncategorised] : categories);

  let totalMonitors = $derived(
    categories.reduce((count, category) => count + category.monitors.length, 0) + uncategorised.monitors.length
  );

  async function call(action: string, data: Record<string, unknown>) {
    const res = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    const result = await res.json();
    if (!res.ok || result.error) throw new Error(result.error || `${action} failed`);
    return result;
  }

  async function load() {
    loading = true;
    try {
      const result = await call("getCategories", {});
      categories = result.categories ?? [];
      uncategorised = result.uncategorised ?? { name: null, monitors: [] };
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load categories";
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function openRename(name: string) {
    renaming = name;
    renameTo = name;
  }

  async function confirmRename() {
    if (!renaming) return;
    busy = true;
    try {
      const result = await call("renameCategory", { from: renaming, to: renameTo });
      toast.success(`Moved ${result.moved} component${result.moved === 1 ? "" : "s"} to "${renameTo.trim()}"`);
      renaming = null;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rename that category");
    } finally {
      busy = false;
    }
  }

  async function removeCategory(name: string) {
    busy = true;
    try {
      const result = await call("deleteCategory", { name });
      toast.success(`${result.cleared} component${result.cleared === 1 ? "" : "s"} are now uncategorised`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not clear that category");
    } finally {
      busy = false;
    }
  }

  function openMove(monitor: CategoryMonitor, from: string | null) {
    moving = monitor;
    moveTo = from ?? "";
  }

  async function confirmMove() {
    if (!moving) return;
    busy = true;
    try {
      await call("setMonitorCategory", { tag: moving.tag, category: moveTo });
      const target = moveTo.trim();
      toast.success(target ? `${moving.name} moved to "${target}"` : `${moving.name} is now uncategorised`);
      moving = null;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not move that component");
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Categories</title></svelte:head>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
  <div>
    <h1 class="text-2xl font-semibold">Categories</h1>
    <p class="text-muted-foreground text-sm">
      The sections a status page shows when its Component Grouping is set to
      <span class="font-medium">Group by category</span>. A category belongs to the component, so it applies on every
      page that component appears on. Sections appear in the order the components appear on each page, and anything
      uncategorised is collected into a final <span class="font-medium">Other</span> section.
    </p>
  </div>

  {#if loading}
    <div class="flex justify-center p-8"><Spinner /></div>
  {:else if error}
    <Card.Root><Card.Content class="p-6 text-red-600">{error}</Card.Content></Card.Root>
  {:else if totalMonitors === 0}
    <Card.Root>
      <Card.Content class="text-muted-foreground p-8 text-center text-sm">
        No components yet. Categories are made by putting a component in one, so there is nothing to group until a
        monitor exists.
      </Card.Content>
    </Card.Root>
  {:else}
    {#each sections as section (section.name ?? "__uncategorised__")}
      <Card.Root>
        <Card.Header>
          <div class="flex items-start justify-between gap-4">
            <div>
              <Card.Title class="flex items-center gap-2">
                {section.name ?? "Other"}
                {#if section.name === null}<Badge variant="secondary">Uncategorised</Badge>{/if}
              </Card.Title>
              <Card.Description>
                {section.monitors.length} component{section.monitors.length === 1 ? "" : "s"}
                {#if section.name === null}
                  &middot; shown as <span class="font-medium">Other</span> on a grouped page
                {/if}
              </Card.Description>
            </div>
            {#if section.name !== null}
              <div class="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" disabled={busy} onclick={() => openRename(section.name as string)}>
                  <PencilIcon class="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onclick={() => removeCategory(section.name as string)}
                >
                  <TrashIcon class="size-4" />
                </Button>
              </div>
            {/if}
          </div>
        </Card.Header>
        <Card.Content class="flex flex-col gap-2">
          {#each section.monitors as monitor (monitor.tag)}
            <div class="flex items-center justify-between gap-3 rounded-md border p-2">
              <div class="min-w-0">
                <div class="flex items-center gap-2 truncate text-sm font-medium">
                  {monitor.name}
                  {#if monitor.is_hidden === "YES"}<Badge variant="secondary">Hidden</Badge>{/if}
                  {#if monitor.status !== "ACTIVE"}<Badge variant="outline">Inactive</Badge>{/if}
                </div>
                <div class="text-muted-foreground truncate text-xs">{monitor.slug}</div>
              </div>
              <Button variant="outline" size="sm" disabled={busy} onclick={() => openMove(monitor, section.name)}>
                Move
              </Button>
            </div>
          {/each}
        </Card.Content>
      </Card.Root>
    {/each}
  {/if}
</div>

<Dialog.Root open={renaming !== null} onOpenChange={(open) => (renaming = open ? renaming : null)}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Rename &ldquo;{renaming}&rdquo;</Dialog.Title>
      <Dialog.Description>
        Every component in this category moves with it. Renaming to a category that already exists merges the two, which
        is how two sections are combined.
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-2">
      <Label for="category-rename">New name</Label>
      <Input id="category-rename" bind:value={renameTo} placeholder="Platform" />
    </div>
    <Dialog.Footer>
      <Button variant="outline" disabled={busy} onclick={() => (renaming = null)}>Cancel</Button>
      <Button disabled={busy || renameTo.trim().length === 0} onclick={confirmRename}>Rename</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={moving !== null} onOpenChange={(open) => (moving = open ? moving : null)}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Move {moving?.name}</Dialog.Title>
      <Dialog.Description>
        Pick a category this component already shares with others, or type a new one. Leave it empty to make the
        component uncategorised.
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-2">
      <Label for="category-move">Category</Label>
      <Input id="category-move" bind:value={moveTo} placeholder="Leave empty for Other" />
      {#if categoryNames.length > 0}
        <div class="flex flex-wrap gap-1 pt-1">
          {#each categoryNames as name (name)}
            <Button variant="outline" size="sm" disabled={busy} onclick={() => (moveTo = name)}>{name}</Button>
          {/each}
        </div>
      {/if}
    </div>
    <Dialog.Footer>
      <Button variant="outline" disabled={busy} onclick={() => (moving = null)}>Cancel</Button>
      <Button disabled={busy} onclick={confirmMove}>Move</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
