<script lang="ts">
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import type { PageExplanation } from "$lib/server/incidents/explain.js";

  /**
   * Why a status page says what it says.
   *
   * Rendering only: the explanation is derived on the server by the same
   * `derivePageStatus` the public page runs, so this component can never be the
   * reason the panel and the page disagree.
   *
   * **Ordered worst first, deliberately.** This is opened by somebody asking
   * "why is this not green", so the components that answer that question are the
   * ones that must not need scrolling to.
   */
  interface Props {
    explanation: (PageExplanation & { page_name: string }) | null;
    loading?: boolean;
    error?: string | null;
  }

  let { explanation, loading = false, error = null }: Props = $props();

  const RANK: Record<string, number> = {
    MAJOR_OUTAGE: 0,
    PARTIAL_OUTAGE: 1,
    DEGRADED_PERFORMANCE: 2,
    UNDER_MAINTENANCE: 3,
    OPERATIONAL: 4
  };

  let ordered = $derived(
    [...(explanation?.components ?? [])].sort((a, b) => {
      // A component that has never reported sits with the problems, not with the
      // healthy ones: it is excluded from the headline's arithmetic, which is
      // exactly the kind of thing this panel exists to stop being invisible.
      const rank = (c: typeof a) => (c.counted ? (RANK[c.impact] ?? 9) : 3.5);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    })
  );

  const sourceLabel: Record<string, string> = {
    override: "incident override",
    incident: "incident",
    maintenance: "maintenance",
    rollup: "dependency",
    monitoring: "its own check",
    silent: "no data"
  };

  function badgeVariant(impact: string, counted: boolean): "default" | "secondary" | "destructive" | "outline" {
    if (!counted) return "outline";
    if (impact === "MAJOR_OUTAGE") return "destructive";
    if (impact === "OPERATIONAL") return "secondary";
    return "default";
  }
</script>

{#if loading}
  <div class="flex justify-center p-6"><Spinner /></div>
{:else if error}
  <p class="text-destructive text-sm">{error}</p>
{:else if explanation}
  <div class="flex flex-col gap-4">
    <div class="rounded-md border p-3">
      <p class="text-base font-semibold">{explanation.headline || "No status"}</p>
      <p class="text-muted-foreground mt-1 text-sm">{explanation.headline_reason}</p>
      {#if explanation.components.length > 0}
        <div class="mt-2 flex flex-wrap gap-2">
          <Badge variant="secondary">{explanation.counts.up} operational</Badge>
          {#if explanation.counts.degraded > 0}<Badge>{explanation.counts.degraded} degraded</Badge>{/if}
          {#if explanation.counts.down > 0}<Badge variant="destructive">{explanation.counts.down} down</Badge>{/if}
          {#if explanation.counts.maintenance > 0}
            <Badge>{explanation.counts.maintenance} under maintenance</Badge>
          {/if}
        </div>
      {/if}
    </div>

    {#each ordered as component (component.monitor_tag)}
      <div class="flex flex-col gap-2 rounded-md border p-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-medium">{component.name}</span>
          <Badge variant={badgeVariant(component.impact, component.counted)}>{component.summary}</Badge>
          <Badge variant="outline">from {sourceLabel[component.source] ?? component.source}</Badge>
          {#if !component.counted}
            <Badge variant="outline">not counted in the headline</Badge>
          {/if}
        </div>
        <p class="text-muted-foreground text-sm">{component.reason}</p>

        {#if component.pin}
          <p class="text-muted-foreground text-xs">
            Pinned at {component.pin.impact}{component.pin.expires_at
              ? `, until ${new Date(component.pin.expires_at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`
              : ", with no expiry"}.
          </p>
        {/if}

        {#if component.own_check && component.own_check !== component.own_status}
          <!-- C3c writes the published verdict into `status` and leaves the
               check's own observation in `raw_status`. When they differ the
               difference IS the answer, so it is spelled out rather than left
               to the sentence above. -->
          <p class="text-muted-foreground text-xs">
            Published as {component.own_status}, but its own check observed {component.own_check}.
          </p>
        {/if}
      </div>
    {:else}
      <p class="text-muted-foreground text-sm">This page has no visible components.</p>
    {/each}
  </div>
{/if}
