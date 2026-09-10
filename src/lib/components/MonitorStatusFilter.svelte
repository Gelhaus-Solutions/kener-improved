<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { t } from "$lib/stores/i18n";
  import GC from "$lib/global-constants";
  import trackEvent from "$lib/beacon";
  import type { StatusType } from "$lib/types/status";
  import { ALL_FILTER, countByStatus, type StatusFilter } from "$lib/client/monitorGrouping";

  // G1: the status filter chips.
  //
  // Presentational and free. Every status it renders is already in
  // `statusByTag`, which the page fetched for the bars, so selecting a filter
  // issues no request - which is the acceptance criterion, and the reason this
  // takes the loaded data as a prop rather than fetching anything of its own.

  interface Props {
    /** Every tag on the page, in page order. */
    tags: string[];
    /** Current status per tag; a tag missing here has not loaded yet. */
    statusByTag: Record<string, StatusType | undefined>;
    value: StatusFilter;
  }

  let { tags, statusByTag, value = $bindable() }: Props = $props();

  const counts = $derived(countByStatus(tags, statusByTag));
  const loadedCount = $derived(Object.values(counts).reduce((sum, n) => sum + n, 0));

  /**
   * Worst first, and fixed rather than sorted by count.
   *
   * During an incident the chip somebody is reaching for is DOWN, and a row that
   * reorders itself as monitors recover would move it out from under the cursor.
   */
  const ORDER: StatusType[] = [GC.DOWN, GC.DEGRADED, GC.MAINTENANCE, GC.NO_DATA, GC.UP];
  const present = $derived(ORDER.filter((status) => (counts[status] ?? 0) > 0));

  /**
   * Hidden until there is a choice to make.
   *
   * One chip and an "All" chip that select the same set is not a filter, it is
   * two buttons that do nothing. A healthy page shows no control at all.
   */
  const hasChoice = $derived(present.length > 1);

  // Explicit rather than `text-${status.toLowerCase()}`: these live in
  // kener.css and NO_DATA has no colour of its own, so the mapping is not
  // mechanical.
  function textClass(status: StatusType): string {
    switch (status) {
      case GC.DOWN:
        return "text-down";
      case GC.DEGRADED:
        return "text-degraded";
      case GC.MAINTENANCE:
        return "text-maintenance";
      case GC.UP:
        return "text-up";
      default:
        return "text-muted-foreground";
    }
  }

  function select(next: StatusFilter) {
    value = next;
    trackEvent("status_filter_changed", { status: next });
  }
</script>

{#if hasChoice}
  <div class="flex flex-wrap items-center gap-2" role="group" aria-label={$t("Filter by status")}>
    <Button
      variant={value === ALL_FILTER ? "outline" : "ghost"}
      size="sm"
      aria-pressed={value === ALL_FILTER}
      class="bg-background/80 dark:bg-background/70 border-foreground/10 rounded-full border text-xs shadow-none backdrop-blur-md"
      onclick={() => select(ALL_FILTER)}
    >
      {$t("All")}
      <span class="text-muted-foreground ml-1 tabular-nums">{loadedCount}</span>
    </Button>

    {#each present as status (status)}
      <Button
        variant={value === status ? "outline" : "ghost"}
        size="sm"
        aria-pressed={value === status}
        class="bg-background/80 dark:bg-background/70 border-foreground/10 rounded-full border text-xs shadow-none backdrop-blur-md"
        onclick={() => select(status)}
      >
        <span class={textClass(status)}>{$t(status)}</span>
        <span class="text-muted-foreground ml-1 tabular-nums">{counts[status]}</span>
      </Button>
    {/each}
  </div>
{/if}
