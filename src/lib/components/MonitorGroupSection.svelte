<script lang="ts">
  import type { Snippet } from "svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { t } from "$lib/stores/i18n";
  import GC from "$lib/global-constants";
  import trackEvent from "$lib/beacon";
  import type { StatusType } from "$lib/types/status";

  // G2: one collapsible category section on the public page.
  //
  // **This is a visual grouping, not a GROUP monitor**, and the two must not read
  // as the same thing. A GROUP monitor is a synthetic monitor with its own bar
  // and its own computed status; this is a heading over monitors that happen to
  // share a `category_name`. So a section renders as a heading and never as a
  // bar, its summary is plainly labelled as a summary, and it carries no link of
  // its own. Users conflating the two is where most of the upstream confusion
  // about groups comes from.

  interface Props {
    /** The category name, or null for the uncategorised section. */
    label: string | null;
    /** How many monitors are inside, after filtering. */
    count: number;
    /** Worst-of over the members, from `summariseStatuses`. */
    summaryStatus: StatusType;
    showSummary: boolean;
    open: boolean;
    /**
     * A callback rather than `bind:open`, because open-ness is not this
     * component's to own. The page overrides it while a status filter is active
     * (a filter is a request to *see* what matched, so a collapsed section would
     * hide the answer), and a two-way binding would fight that.
     */
    ontoggle: (open: boolean) => void;
    children: Snippet;
  }

  let { label, count, summaryStatus, showSummary, open, ontoggle, children }: Props = $props();

  const heading = $derived(label ?? $t("Other"));

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

  function toggle() {
    const next = !open;
    ontoggle(next);
    trackEvent("monitor_group_toggled", { open: String(next) });
  }
</script>

<div class="overflow-hidden rounded-3xl border">
  <button
    type="button"
    class="hover:bg-muted/40 flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors sm:px-4"
    aria-expanded={open}
    onclick={toggle}
  >
    {#if open}
      <ChevronDown class="text-muted-foreground h-4 w-4 shrink-0" />
    {:else}
      <ChevronRight class="text-muted-foreground h-4 w-4 shrink-0" />
    {/if}

    <span class="truncate text-sm font-medium">{heading}</span>
    <span class="text-muted-foreground shrink-0 text-xs tabular-nums">{count}</span>

    {#if showSummary}
      <!-- Worst-of over the members, via the same collapse the bars use, so the
           heading and the bars underneath it cannot disagree. -->
      <span class="ml-auto shrink-0 text-xs {textClass(summaryStatus)}">{$t(summaryStatus)}</span>
    {/if}
  </button>

  {#if open}
    <div class="border-t">
      {@render children()}
    </div>
  {/if}
</div>
