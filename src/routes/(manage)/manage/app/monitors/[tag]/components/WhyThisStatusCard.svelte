<script lang="ts">
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import type { ComponentExplanation } from "$lib/server/incidents/explain.js";

  /**
   * Why this monitor reads the way it does.
   *
   * `ComponentStatus.source` has recorded which rule decided a component since
   * C2b and nothing surfaced it, so "why does this say Major System Outage"
   * meant reading the derivation and querying four tables. Derived on the
   * server by the same code the public page runs, so this can never be the
   * reason the card and the page disagree.
   */
  interface Props {
    monitorTag: string;
  }

  let { monitorTag }: Props = $props();

  type Explanation = ComponentExplanation & { dependencies: string[] };

  let explanation = $state<Explanation | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const SOURCE_LABEL: Record<string, string> = {
    override: "an incident override",
    incident: "an incident",
    maintenance: "a maintenance",
    rollup: "a dependency",
    monitoring: "its own check",
    silent: "no data"
  };

  async function load() {
    loading = true;
    error = null;
    try {
      const response = await fetch(clientResolver(resolve, "/manage/api"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "explainMonitorStatus", data: { monitor_tag: monitorTag } })
      });
      const result = await response.json();
      if (result.error) error = result.error;
      else explanation = result;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not explain this monitor";
    } finally {
      loading = false;
    }
  }

  onMount(load);
</script>

<div class="flex flex-col gap-3">
  {#if loading}
    <div class="flex justify-center p-4"><Spinner /></div>
  {:else if error}
    <p class="text-destructive text-sm">{error}</p>
  {:else if explanation}
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-base font-semibold">{explanation.summary}</span>
      <Badge variant="outline">decided by {SOURCE_LABEL[explanation.source] ?? explanation.source}</Badge>
      <Button variant="ghost" size="sm" class="ml-auto" onclick={load} title="Derive again">
        <RefreshIcon class="size-4" />
      </Button>
    </div>

    <p class="text-muted-foreground text-sm">{explanation.reason}</p>

    {#if explanation.own_check && explanation.own_check !== explanation.own_status}
      <!-- C3c writes the published verdict into `status` and leaves the check's
           own observation in `raw_status`. When they differ the difference IS
           the answer, so it is spelled out rather than left to the sentence. -->
      <p class="text-muted-foreground text-xs">
        Published as {explanation.own_status}, but its own check observed {explanation.own_check}.
      </p>
    {/if}

    {#if explanation.incidents.length > 0}
      <div class="flex flex-col gap-1">
        <p class="text-xs font-medium">Open incidents on this monitor</p>
        {#each explanation.incidents as incident (incident.id)}
          <p class="text-muted-foreground text-xs">
            {incident.title || `#${incident.id}`} declares {incident.impact}
          </p>
        {/each}
      </div>
    {/if}

    {#if explanation.maintenances.length > 0}
      <div class="flex flex-col gap-1">
        <p class="text-xs font-medium">Ongoing maintenances</p>
        {#each explanation.maintenances as maintenance (maintenance.id)}
          <p class="text-muted-foreground text-xs">
            {maintenance.title || `#${maintenance.id}`} declares {maintenance.impact}
          </p>
        {/each}
      </div>
    {/if}

    {#if explanation.pin}
      <p class="text-muted-foreground text-xs">
        Pinned at {explanation.pin.impact}{explanation.pin.expires_at
          ? `, until ${new Date(explanation.pin.expires_at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`
          : ", with no expiry"}.
      </p>
    {/if}

    {#if explanation.dependencies.length > 0}
      <p class="text-muted-foreground text-xs">
        Depends on {explanation.dependencies.join(", ")}.
        {#if explanation.inherited_from.length === 0}
          None of them is currently worse than this monitor's own check.
        {/if}
      </p>
    {/if}
  {/if}
</div>
