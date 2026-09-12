<script lang="ts">
  import { t } from "$lib/stores/i18n";
  import type { PublicSlo } from "$lib/types/slo";

  /**
   * An inline SLO figure, for the two placements that sit next to something else
   * (F1a): beside a component in the status page list, and on a category section
   * header.
   *
   * **Deliberately not the panel.** Those two placements share a row with a name
   * and a status, so a card would push the thing it annotates off the line on a
   * phone. This renders one short figure per target and nothing else, whatever
   * preset the target carries - the extra FULL fields belong in a panel where
   * there is room to label them.
   *
   * `breachedOnly` is what the status-page badge uses. A breach is surfaced
   * wherever the thing it concerns appears, even when the operator placed the
   * figure elsewhere, which is the one case where something appears on a surface
   * it was not placed on. See `services/sloPublic.ts`.
   */

  interface Props {
    slos?: PublicSlo[];
    /** Show only breached targets. Used for the always-on breach signal. */
    breachedOnly?: boolean;
    class?: string;
  }

  let { slos = [], breachedOnly = false, class: className = "" }: Props = $props();

  let shown = $derived(breachedOnly ? slos.filter((slo) => slo.breached) : slos);

  const pct = (value: number) => `${value.toFixed(3)}%`;
</script>

{#if shown.length > 0}
  <span class="inline-flex flex-wrap items-center gap-1 {className}">
    {#each shown as slo (slo.name)}
      {#if slo.breached}
        <span
          class="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-xs font-medium text-white"
          title="{slo.name}: {pct(slo.uptimePercent)} against {pct(slo.objectivePercent)}"
        >
          {$t("SLA breached")}
          <span class="font-normal">{pct(slo.uptimePercent)}</span>
        </span>
      {:else}
        <span
          class="text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
          title="{slo.name}: {pct(slo.uptimePercent)} against {pct(slo.objectivePercent)}"
        >
          {pct(slo.uptimePercent)}
          <span class="opacity-70">/ {pct(slo.objectivePercent)}</span>
        </span>
      {/if}
    {/each}
  </span>
{/if}
