<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import { onMount } from "svelte";
  import { Spinner } from "$lib/components/ui/spinner/index.js";

  interface Edge {
    parent_monitor_tag: string;
    child_monitor_tag: string;
    relation: string;
    propagation: string;
    weight: number;
  }
  interface Setting {
    monitor_tag: string;
    rollup_mode: string;
    manual_override: string | null;
    manual_override_expires_at: number | null;
  }

  let edges = $state<Edge[]>([]);
  let settings = $state<Setting[]>([]);
  let names = $state<Record<string, string>>({});
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const res = await fetch(clientResolver(resolve, "/manage/api"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "getDependencyGraph", data: {} })
      });
      const result = await res.json();
      if (!res.ok || result.error) throw new Error(result.error || "Could not load the graph");
      edges = result.edges ?? [];
      settings = result.settings ?? [];
      names = result.names ?? {};
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load the graph";
    } finally {
      loading = false;
    }
  });

  // Roots are the components nothing depends on. Rendering from them downwards
  // is what makes the shape readable: a list of edges tells you the same facts
  // and none of the structure.
  let roots = $derived.by(() => {
    const parents = new Set(edges.map((e) => e.parent_monitor_tag));
    const children = new Set(edges.map((e) => e.child_monitor_tag));
    return [...parents].filter((tag) => !children.has(tag)).sort();
  });

  let childrenOf = $derived.by(() => {
    const map = new Map<string, Edge[]>();
    for (const edge of edges) {
      const list = map.get(edge.parent_monitor_tag) ?? [];
      list.push(edge);
      map.set(edge.parent_monitor_tag, list);
    }
    return map;
  });

  let settingOf = $derived(new Map(settings.map((s) => [s.monitor_tag, s])));

  const label = (tag: string) => names[tag] ?? tag;

  /** Flattens the tree into indented rows, stopping at the depth the rollup stops at. */
  function rows(tag: string, depth: number, seen: Set<string>): Array<{ tag: string; depth: number; edge?: Edge }> {
    if (depth > 10 || seen.has(tag)) return [{ tag, depth }];
    const next = new Set(seen).add(tag);
    const out: Array<{ tag: string; depth: number; edge?: Edge }> = [{ tag, depth }];
    for (const edge of childrenOf.get(tag) ?? []) {
      out.push(...rows(edge.child_monitor_tag, depth + 1, next).map((r, i) => (i === 0 ? { ...r, edge } : r)));
    }
    return out;
  }
</script>

<svelte:head><title>Dependencies</title></svelte:head>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-semibold">Dependencies</h1>
      <p class="text-muted-foreground text-sm">
        How your components are composed. Edit these on each monitor's own page.
      </p>
    </div>
    <Button variant="outline" href={clientResolver(resolve, "/manage/app/monitors")}>Monitors</Button>
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><Spinner class="size-8" /></div>
  {:else if error}
    <Card.Root class="border-destructive">
      <Card.Content class="pt-6"><p class="text-destructive">{error}</p></Card.Content>
    </Card.Root>
  {:else if edges.length === 0}
    <Card.Root>
      <Card.Content class="pt-6">
        <p class="text-muted-foreground text-sm">
          Nothing depends on anything yet. Open a monitor and add what it is made of, and the shape will appear here.
        </p>
      </Card.Content>
    </Card.Root>
  {:else}
    {#each roots as root (root)}
      <Card.Root>
        <Card.Header>
          <Card.Title class="text-base">{label(root)}</Card.Title>
        </Card.Header>
        <Card.Content class="flex flex-col gap-1">
          {#each rows(root, 0, new Set()) as row (row.tag + row.depth + (row.edge?.parent_monitor_tag ?? ""))}
            <div class="flex items-center gap-2 text-sm" style="padding-left: {row.depth * 20}px">
              {#if row.depth > 0}<span class="text-muted-foreground">└</span>{/if}
              <span class="font-mono">{row.tag}</span>
              <span class="text-muted-foreground text-xs">{label(row.tag)}</span>
              {#if row.edge && row.edge.propagation === "NONE"}
                <Badge variant="outline" class="text-xs">recorded only</Badge>
              {:else if row.edge && row.edge.propagation === "WEIGHTED"}
                <Badge variant="secondary" class="text-xs">weight {row.edge.weight}</Badge>
              {/if}
              {#if settingOf.get(row.tag)?.manual_override}
                <Badge variant="destructive" class="text-xs">
                  pinned {settingOf.get(row.tag)?.manual_override}
                </Badge>
              {/if}
            </div>
          {/each}
        </Card.Content>
      </Card.Root>
    {/each}
  {/if}
</div>
