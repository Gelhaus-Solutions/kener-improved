<script lang="ts">
  import * as Item from "$lib/components/ui/item/index.js";
  import { t } from "$lib/stores/i18n";
  import MonitorSloPanel from "$lib/components/MonitorSloPanel.svelte";
  import { formatDate } from "$lib/stores/datetime";
  import { Button } from "$lib/components/ui/button/index.js";
  import ThemePlus from "$lib/components/ThemePlus.svelte";
  import MonitorOverview from "$lib/components/MonitorOverview.svelte";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import clientResolver, { absoluteResolve } from "$lib/client/resolver.js";
  import { resolve } from "$app/paths";
  import trackEvent from "$lib/beacon";
  import IncidentItem from "$lib/components/IncidentItem.svelte";
  import MaintenanceItem from "$lib/components/MaintenanceItem.svelte";
  import { page } from "$app/state";
  import RegionMap from "$lib/components/regions/RegionMap.svelte";
  import { liveStatus } from "$lib/client/liveStatus.svelte.js";
  import { statusFromSample, type RegionMapEntry } from "$lib/regions/mapModel";
  let { data } = $props();

  // State
  let descriptionExpanded = $state(false);
  let showInlineEvents = $derived(data.eventDisplaySettings?.showInlineEvents === true);

  function toggleDescription(expanded: boolean) {
    descriptionExpanded = expanded;
    trackEvent("monitor_description_toggled", { expanded, monitorTag: data.monitorTag });
  }

  function trackExternalLinkClick() {
    trackEvent("monitor_external_link_clicked", { monitorTag: data.monitorTag });
  }

  /**
   * B13 stage 1. The region map, server-rendered and then kept live.
   *
   * The loader's model is the first paint, so the map is correct with JavaScript
   * off and correct before the stream connects. Each live `region_status` event
   * then overrides its own region, and `statusFromSample` is re-applied rather
   * than the event's status being trusted directly - that is what keeps
   * freshness meaning the same thing on both paths, so a region that stops
   * reporting goes grey by the same rule whether the page was just loaded or has
   * been open for an hour.
   */
  // Wall clock, and one of the few things `$derived` genuinely cannot express:
  // nothing in the component's state changes when a minute passes, and staleness
  // depends on the passage of time rather than on any input. The autofixer flags
  // "stateful variable assigned inside an $effect" here; this is the case its own
  // guidance says to ignore.
  let now = $state(Math.floor(Date.now() / 1000));
  $effect(() => {
    // Re-evaluated every 30s so a region that goes quiet fades to "no recent
    // data" on an open page, rather than holding its last colour for ever.
    const timer = setInterval(() => (now = Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  });

  const regionEntries = $derived(
    (data.regionMap ?? []).map((entry: RegionMapEntry) => {
      const live = liveStatus.regionStatusByKey[`${data.monitorTag}:${entry.id}`];
      const sample = live ?? (entry.observedAt === null ? null : { status: entry.status, timestamp: entry.observedAt });
      const status = statusFromSample(sample, now);
      return {
        ...entry,
        status,
        observedAt: status === "NO_DATA" ? null : (sample?.timestamp ?? null),
        latencyMs: status === "NO_DATA" ? null : (live ? live.latency : entry.latencyMs)
      } satisfies RegionMapEntry;
    })
  );
</script>

<svelte:head>
  <title>{data.monitorName + " - " + data.siteName}</title>
  <meta property="og:title" content={data.monitorName + " - " + data.siteName} />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  {#if data.monitorDescription}
    <meta name="description" content={data.monitorDescription} />
    <meta property="og:description" content={data.monitorDescription} />
  {/if}
  {#if data.socialPreviewImage}
    <meta property="og:image" content={absoluteResolve(resolve, data.siteUrl, data.socialPreviewImage)} />
    <meta name="twitter:image" content={absoluteResolve(resolve, data.siteUrl, data.socialPreviewImage)} />
  {/if}
</svelte:head>
<div class="flex flex-col gap-3">
  <ThemePlus
    monitor_tags={[data.monitorTag]}
    embedMonitorTag={data.monitorTag}
    hideNotificationsPopover={showInlineEvents}
  />
  <div class="flex flex-col gap-2 px-4 py-2">
    {#if data.monitorImage}
      <img
        src={clientResolver(resolve, data.monitorImage)}
        alt={data.monitorName || "Monitor icon"}
        class="aspect-auto w-12 rounded object-cover"
      />
    {/if}
    <Item.Root class="px-0 py-0 ">
      <Item.Content>
        {#if data.monitorName}
          <h1>
            <Item.Title class="text-3xl">{data.monitorName}</Item.Title>
          </h1>
        {/if}
        {#if data.monitorDescription}
          <h2 class="">
            <Item.Description
              class="text-muted-foreground w-full {descriptionExpanded ? 'line-clamp-none' : ''} text-pretty"
            >
              {#if data.monitorDescription.length > 150 && !descriptionExpanded}
                {data.monitorDescription.slice(0, 150)}...
                <button
                  class="text-accent-foreground inline font-medium hover:underline"
                  onclick={() => toggleDescription(true)}
                >
                  {$t("Read more")}
                </button>
              {:else if data.monitorDescription.length > 150}
                {data.monitorDescription}
                <button
                  class="text-accent-foreground inline font-medium hover:underline"
                  onclick={() => toggleDescription(false)}
                >
                  {$t("Read less")}
                </button>
              {:else}
                {data.monitorDescription}
              {/if}
            </Item.Description>
          </h2>
        {/if}
      </Item.Content>
    </Item.Root>
  </div>
  <div class="bg-background flex flex-col justify-start gap-y-3 rounded-3xl border p-4">
    <div class="relative flex flex-col px-2">
      <h2 class="text-base font-medium">{$t("Last Updated")}</h2>
      <p class="text-muted-foreground text-xs">
        <span>{$formatDate(data.monitorLastStatusTimestamp * 1000, page.data.dateAndTimeFormat.datePlusTime)}</span>
      </p>
      {#if !!data.externalUrl}
        <Button
          variant="outline"
          size="icon-sm"
          class="rounded-btn absolute top-0 right-0"
          href={data.externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          onclick={trackExternalLinkClick}
        >
          <ArrowUpRight class="size-4" />
        </Button>
      {/if}
    </div>
    <div class="flex items-center justify-between px-2">
      <div class="flex flex-col items-start gap-1">
        <p class="text-muted-foreground text-2xl font-semibold {data.textClass}">
          {$t(data.monitorLastStatus)}
        </p>
        <p class="text-muted-foreground text-xs">{$t("Latest Status")}</p>
        <!--
          Only rendered when C3's dependency rollup is what set the status above.
          Without it the headline can differ from the monitor's own check with
          nothing on the page to say why, which is the confusion this answers.
        -->
        {#if data.inheritedFrom && data.inheritedFrom.length > 0}
          <p class="text-muted-foreground text-xs">
            {$t("Inherited from %monitors", { monitors: data.inheritedFrom.join(", ") })}
          </p>
        {/if}
        {#if data.monitorOwnStatus}
          <p class="text-muted-foreground text-xs">
            {$t("Own check")}: {$t(data.monitorOwnStatus)}
          </p>
        {/if}
      </div>
      {#if !!data.monitorLastLatency}
        <div class="flex flex-col items-end gap-1">
          <p class="text-right text-2xl font-semibold">
            {data.monitorLastLatency}
          </p>
          <p class="text-muted-foreground text-xs">{$t("Latest Latency")}</p>
        </div>
      {/if}
    </div>
  </div>
  {#if showInlineEvents && data.ongoingIncidents && data.ongoingIncidents.length > 0}
    <div class="flex flex-col gap-3">
      {#each data.ongoingIncidents as incident, i (incident.id ?? i)}
        <div class=" rounded-3xl border p-3 sm:p-4">
          <IncidentItem {incident} />
        </div>
      {/each}
    </div>
  {/if}
  {#if showInlineEvents && data.ongoingMaintenances && data.ongoingMaintenances.length > 0}
    <div class="flex flex-col gap-3">
      {#each data.ongoingMaintenances as maintenance, i (maintenance.id ?? i)}
        <div class="rounded-3xl border p-3 sm:p-4">
          <MaintenanceItem {maintenance} />
        </div>
      {/each}
    </div>
  {/if}
  {#if showInlineEvents && data.upcomingMaintenances && data.upcomingMaintenances.length > 0}
    <div class="flex flex-col gap-3">
      {#each data.upcomingMaintenances as maintenance, i (maintenance.id ?? i)}
        <div class="rounded-3xl border p-3 sm:p-4">
          <MaintenanceItem {maintenance} />
        </div>
      {/each}
    </div>
  {/if}

  <!-- F1a: published SLO attainment. Above the bar, because it is the summary
       figure the bar is the detail of. Renders nothing when no target on this
       component has been published. -->
  <MonitorSloPanel slos={data.publishedSlos || []} />

  <!--
    B13 stage 1. Only when probe regions are actually watching this monitor. An
    install with no probe agents has only the merged verdict, which is not a
    place, so there is nothing to draw and an empty map would be noise.
  -->
  {#if regionEntries.length > 0}
    <div class="px-4 py-2">
      <RegionMap
        entries={regionEntries}
        headline="Checked from {regionEntries.length} {regionEntries.length === 1 ? 'region' : 'regions'}"
        caption="Each pin is one region's own view. The status at the top of this page is the merged verdict across all of them."
      />
    </div>
  {/if}

  <!-- Calendar View (self-contained component with its own API call) -->
  <MonitorOverview
    monitorTag={data.monitorTag}
    maxDays={data.maxDays}
    groupTags={data.extendedTags || []}
    dependsOnTags={data.dependsOnTags || []}
    partOfTags={data.partOfTags || []}
    class="mb-4"
  />
</div>
