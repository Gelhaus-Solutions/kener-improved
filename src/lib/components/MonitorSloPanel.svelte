<script lang="ts">
  import { t } from "$lib/stores/i18n";

  /**
   * The published SLO figures for one component (F1a).
   *
   * Read-only, and deliberately narrow. The server sends four fields per target
   * and nothing else: burn rates and the target's configuration stay behind,
   * because they describe how the provider runs its alerting rather than how the
   * service behaved.
   */
  interface PublishedSlo {
    name: string;
    objectivePercent: number;
    uptimePercent: number;
    budgetRemainingPercent: number | null;
    /** A locale-neutral token, e.g. "30d (UTC)" or "2026-09 (UTC)". */
    window: string;
  }

  interface Props {
    slos?: PublishedSlo[];
    class?: string;
  }

  let { slos = [], class: className = "" }: Props = $props();

  /**
   * Three decimals, because an SLO is usually written with them: 99.9 and 99.95
   * are different promises and rounding to one would collapse them.
   */
  const pct = (value: number, digits = 3) => `${value.toFixed(digits)}%`;

  /** Met when attainment is at or above the objective. */
  const met = (slo: PublishedSlo) => slo.uptimePercent >= slo.objectivePercent;
</script>

{#if slos.length > 0}
  <div class="mb-4 flex flex-col gap-3 {className}">
    <h2 class="text-base font-medium">{$t("Service Level Objectives")}</h2>
    <div class="grid gap-3 sm:grid-cols-2">
      {#each slos as slo (slo.name)}
        <div class="rounded-3xl border p-3 sm:p-4">
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-sm font-medium">{slo.name}</span>
            <span class="text-muted-foreground text-xs">{slo.window}</span>
          </div>
          <div class="mt-2 flex items-baseline gap-2">
            <span class="text-2xl font-semibold" class:text-red-600={!met(slo)}>{pct(slo.uptimePercent)}</span>
            <span class="text-muted-foreground text-xs">
              {$t("Objective")}
              {pct(slo.objectivePercent)}
            </span>
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
