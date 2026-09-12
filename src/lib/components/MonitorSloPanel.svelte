<script lang="ts">
  import { t } from "$lib/stores/i18n";
  import type { PublicSlo } from "$lib/types/slo";

  /**
   * The standing panel of published SLO figures (F1a).
   *
   * Used for two placements: a component's own page (`COMPONENT_PAGE`) and the
   * top of a status page (`PAGE_TOP`). It is the same panel because it is the
   * same statement - a contract and how it is being met - and only the scope of
   * the thing it is about differs, which the heading carries.
   *
   * Read-only and deliberately narrow. `services/sloPublic.ts` decides what
   * reaches the browser at all; this only decides how it looks. The COMPACT
   * preset simply arrives with `window` and `budgetRemainingPercent` already
   * null, so there is no second copy of that rule here.
   */

  interface Props {
    slos?: PublicSlo[];
    /** Overrides the heading. Defaults to the component-scoped wording. */
    heading?: string;
    class?: string;
  }

  let { slos = [], heading, class: className = "" }: Props = $props();

  /**
   * Three decimals, because an SLO is usually written with them: 99.9 and 99.95
   * are different promises and rounding to one would collapse them.
   */
  const pct = (value: number, digits = 3) => `${value.toFixed(digits)}%`;
</script>

{#if slos.length > 0}
  <div class="mb-4 flex flex-col gap-3 {className}">
    <h2 class="text-base font-medium">{heading ?? $t("Service Level Objectives")}</h2>
    <div class="grid gap-3 sm:grid-cols-2">
      {#each slos as slo (slo.name)}
        <div class="rounded-3xl border p-3 sm:p-4" class:border-red-500={slo.breached}>
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-sm font-medium">{slo.name}</span>
            {#if slo.window}<span class="text-muted-foreground text-xs">{slo.window}</span>{/if}
          </div>
          <div class="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span class="text-2xl font-semibold" class:text-red-600={slo.breached}>{pct(slo.uptimePercent)}</span>
            <span class="text-muted-foreground text-xs">
              {$t("Objective")}
              {pct(slo.objectivePercent)}
            </span>
            {#if slo.breached}
              <span class="rounded-full bg-red-600 px-2 py-0.5 text-xs font-medium text-white">
                {$t("SLA breached")}
              </span>
            {/if}
          </div>
          {#if slo.budgetRemainingPercent !== null}
            <div class="text-muted-foreground mt-1 text-xs">
              {$t("Error budget left")}
              <span class="font-medium" class:text-red-600={slo.budgetRemainingPercent < 0}>
                {slo.budgetRemainingPercent.toFixed(1)}%
              </span>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/if}
