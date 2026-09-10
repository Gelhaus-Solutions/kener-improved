<script lang="ts">
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import MonitorBar from "$lib/components/MonitorBar.svelte";
  import MonitorStatusFilter from "$lib/components/MonitorStatusFilter.svelte";
  import MonitorGroupSection from "$lib/components/MonitorGroupSection.svelte";
  import { requestMonitorBar } from "$lib/client/monitor-bar-client";
  import type { MonitorBarResponse } from "$lib/server/api-server/monitor-bar/get";
  import type { PageMonitorLayoutStyle } from "$lib/types/api";
  import type { PageSettingsType } from "$lib/server/types/db";
  import type { StatusType } from "$lib/types/status";
  import { t } from "$lib/stores/i18n";
  import {
    ALL_FILTER,
    applyStatusFilter,
    groupByCategory,
    isStatusFilter,
    summariseStatuses,
    type StatusFilter
  } from "$lib/client/monitorGrouping";

  // The monitor list on a public status page: fetching the bars, G1's status
  // filter, G2's category sections, and the grid itself.
  //
  // **Extracted because the public page exists twice.** `(kener)/+page.svelte`
  // renders the home page and `(kener)/[page_path]/+page.svelte` renders every
  // named page, and the two were near-identical copies of this whole block -
  // fetch effect, grid maths and all. G1 landed in one of them and silently did
  // nothing on named pages, which is exactly the failure that duplication
  // produces and exactly the failure it will produce again next time. One
  // component means a change cannot reach one page and miss the other, and it
  // makes each page's diff against upstream *smaller* rather than larger.

  interface Props {
    monitorTags: string[];
    monitorCategoriesByTag: Record<string, string | null>;
    monitorGroupMembersByTag: Record<string, string[]>;
    pageSettings: PageSettingsType | null;
    barCount: number;
    endOfDayTodayAtTz: number;
  }

  let {
    monitorTags,
    monitorCategoriesByTag,
    monitorGroupMembersByTag,
    pageSettings,
    barCount,
    endOfDayTodayAtTz
  }: Props = $props();

  let monitorBarDataByTag = $state<Record<string, MonitorBarResponse>>({});
  let monitorBarErrorByTag = $state<Record<string, string>>({});
  let requestVersion = 0;

  const viewType = $derived<PageMonitorLayoutStyle | undefined>(pageSettings?.monitor_layout_style);
  const isCompact = $derived(viewType === "compact-list" || viewType === "compact-grid");
  const isGrid = $derived(viewType === "compact-grid" || viewType === "default-grid");

  function getGridItemSpanClass(index: number, total: number, type: typeof viewType): string {
    if (type === "default-grid") {
      const mdLastRowCount = total % 2 || 2;
      const mdLastRowStart = total - mdLastRowCount;
      const isInMdLastRow = index >= mdLastRowStart;
      const mdSpan = isInMdLastRow && mdLastRowCount === 1 ? "md:col-span-4" : "md:col-span-2";

      const lgLastRowCount = total % 2 || 2;
      const lgLastRowStart = total - lgLastRowCount;
      const isInLgLastRow = index >= lgLastRowStart;
      const lgSpan = isInLgLastRow && lgLastRowCount === 1 ? "lg:col-span-4" : "lg:col-span-2";

      return `${mdSpan} ${lgSpan}`;
    }

    const smLastRowCount = total % 2 || 2;
    const smLastRowStart = total - smLastRowCount;
    const isInSmLastRow = index >= smLastRowStart;
    const smSpan = isInSmLastRow && smLastRowCount === 1 ? "sm:col-span-4" : "sm:col-span-2";

    const lgLastRowCount = total % 3 || 3;
    const lgLastRowStart = total - lgLastRowCount;
    const isInLgLastRow = index >= lgLastRowStart;
    const lgSpan = isInLgLastRow
      ? lgLastRowCount === 1
        ? "lg:col-span-6"
        : lgLastRowCount === 2
          ? "lg:col-span-3"
          : "lg:col-span-2"
      : "lg:col-span-2";

    return `${smSpan} ${lgSpan}`;
  }

  function getGridContainerClass(type: typeof viewType): string {
    if (type === "compact-grid") return "bg-border gap-px sm:grid-cols-4 lg:grid-cols-6";
    if (type === "default-grid") return "bg-border gap-px md:grid-cols-4 lg:grid-cols-4";
    return "";
  }

  $effect(() => {
    const tags = monitorTags || [];
    const days = barCount;
    const currentRequestVersion = ++requestVersion;

    monitorBarDataByTag = {};
    monitorBarErrorByTag = {};

    if (!browser || !tags.length) return;

    void Promise.all(
      tags.map(async (tag) => {
        try {
          const monitorBarData = await requestMonitorBar(tag, days, endOfDayTodayAtTz);
          return { tag, ok: true as const, monitorBarData };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : "Unknown error";
          return { tag, ok: false as const, errorMessage };
        }
      })
    ).then((results) => {
      if (currentRequestVersion !== requestVersion) return;

      const nextDataByTag: Record<string, MonitorBarResponse> = {};
      const nextErrorByTag: Record<string, string> = {};

      for (const result of results) {
        if (result.ok) {
          nextDataByTag[result.tag] = result.monitorBarData;
        } else {
          nextErrorByTag[result.tag] = result.errorMessage;
        }
      }

      monitorBarDataByTag = nextDataByTag;
      monitorBarErrorByTag = nextErrorByTag;
    });
  });

  // ---- G1: status filtering -------------------------------------------------
  //
  // Free: every status read here was already fetched above for the bars, so
  // selecting a filter issues no request at all.
  const showStatusFilter = $derived(pageSettings?.status_filter?.enabled === true);

  /** Current status per tag; absent while a monitor's bar data is still loading. */
  const statusByTag = $derived.by(() => {
    const out: Record<string, StatusType | undefined> = {};
    for (const tag of monitorTags || []) out[tag] = monitorBarDataByTag[tag]?.currentStatus;
    return out;
  });

  // Seeded from the URL so a filtered view is shareable, which is the point of
  // putting it there: during an incident somebody wants to send "here is what is
  // broken", not "open this and click Down".
  let statusFilter = $state<StatusFilter>(
    isStatusFilter(page.url.searchParams.get("status"))
      ? (page.url.searchParams.get("status") as StatusFilter)
      : ALL_FILTER
  );

  const isFiltering = $derived(showStatusFilter && statusFilter !== ALL_FILTER);

  $effect(() => {
    if (!browser) return;
    const next = new URL(page.url);
    if (statusFilter === ALL_FILTER) next.searchParams.delete("status");
    else next.searchParams.set("status", statusFilter);
    // `replaceState`, not `pushState`: a filter is a view of this page, not a
    // place. Pushing would make the back button walk through every chip the
    // visitor tried instead of leaving the page they came from.
    if (next.href !== page.url.href) replaceState(next, page.state);
  });

  const visibleTags = $derived(
    showStatusFilter ? applyStatusFilter(monitorTags || [], statusByTag, statusFilter) : monitorTags || []
  );

  // ---- G2: category grouping ------------------------------------------------
  const isGrouped = $derived((pageSettings?.group_display?.mode ?? "none") === "category");
  const showGroupSummary = $derived(pageSettings?.group_display?.show_group_summary !== false);
  const collapsedByDefault = $derived(pageSettings?.group_display?.collapsed_by_default === true);

  const groups = $derived(isGrouped ? groupByCategory(visibleTags, monitorCategoriesByTag || {}) : []);

  /** Only sections the visitor has actually toggled; everything else follows the setting. */
  let openOverrides = $state<Record<string, boolean>>({});

  function isGroupOpen(key: string): boolean {
    // A filter is a request to see what matched, so it wins over both the
    // per-page default and any section the visitor had collapsed.
    if (isFiltering) return true;
    return openOverrides[key] ?? !collapsedByDefault;
  }

  function setGroupOpen(key: string, open: boolean) {
    openOverrides = { ...openOverrides, [key]: open };
  }
</script>

{#snippet bars(tags: string[])}
  <div class={`grid grid-cols-1 ${getGridContainerClass(viewType)}`}>
    {#each tags as tag, i (tag)}
      <div
        class="{isGrid
          ? `${getGridItemSpanClass(i, tags.length, viewType)} bg-background`
          : i < tags.length - 1
            ? 'border-b'
            : ''} px-2 py-2 sm:px-0"
      >
        <MonitorBar
          {tag}
          prefetchedData={monitorBarDataByTag[tag]}
          prefetchedError={monitorBarErrorByTag[tag]}
          days={barCount}
          {endOfDayTodayAtTz}
          groupChildTags={monitorGroupMembersByTag?.[tag] || []}
          compact={isCompact}
          grid={isGrid}
        />
      </div>
    {/each}
  </div>
{/snippet}

{#if showStatusFilter}
  <MonitorStatusFilter tags={monitorTags} {statusByTag} bind:value={statusFilter} />
{/if}

{#if visibleTags.length === 0}
  <div class="text-muted-foreground rounded-3xl border px-4 py-6 text-center text-sm">
    {$t("No components match this filter")}
  </div>
{:else if isGrouped}
  <!-- G2: category sections. A visual grouping over `category_name`, never a
       GROUP monitor - see MonitorGroupSection for why that distinction is kept
       visible. -->
  <div class="flex flex-col gap-3 sm:gap-4">
    {#each groups as group (group.key)}
      <MonitorGroupSection
        label={group.label}
        count={group.tags.length}
        summaryStatus={summariseStatuses(group.tags.map((tag) => statusByTag[tag]))}
        showSummary={showGroupSummary}
        open={isGroupOpen(group.key)}
        ontoggle={(open) => setGroupOpen(group.key, open)}
      >
        {@render bars(group.tags)}
      </MonitorGroupSection>
    {/each}
  </div>
{:else}
  <div class="overflow-hidden rounded-3xl border">
    {@render bars(visibleTags)}
  </div>
{/if}
