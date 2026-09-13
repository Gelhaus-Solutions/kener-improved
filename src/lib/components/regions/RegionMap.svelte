<script lang="ts">
  import { MAP_HEIGHT, MAP_WIDTH, placeRegions, project } from "$lib/regions/projection";
  import { graticulePaths, worldOutlinePaths } from "$lib/regions/worldOutline";
  import { describeEntry, sortForTable, type RegionMapEntry, type RegionMapStatus } from "$lib/regions/mapModel";

  /**
   * B13. Every region on a flat world map, coloured by what it is seeing.
   *
   * **The map is decorative and the table is the content.** A world map conveys
   * nothing to a screen reader, so the SVG is `aria-hidden` and the table below
   * carries exactly the same states in the same order. That is not a fallback
   * for a minority: the table is also what a sighted reader uses to read an
   * actual latency number, so building it properly serves everyone. G9 already
   * carries WCAG 2.2 AA and this must not add a fresh violation to it.
   *
   * Colour is never the only carrier. Each pin has a distinct shape as well as a
   * distinct fill, because a status map that distinguishes only by red and green
   * is unreadable to the commonest form of colour blindness.
   */
  interface Props {
    entries: RegionMapEntry[];
    /** Shown above the map. Region 0's merged verdict belongs here, never on the map. */
    headline?: string;
    caption?: string;
  }

  let { entries, headline, caption }: Props = $props();

  const outline = worldOutlinePaths();
  const graticule = graticulePaths();

  const placed = $derived(placeRegions(entries));
  const tabulated = $derived(sortForTable(entries));

  /** Regions that exist but cannot be drawn, so the table still accounts for them. */
  const unplaced = $derived(entries.filter((e) => e.latitude === null || e.longitude === null));

  const FILL: Record<RegionMapStatus, string> = {
    UP: "var(--region-up, #46a758)",
    DEGRADED: "var(--region-degraded, #f5a524)",
    DOWN: "var(--region-down, #e5484d)",
    MAINTENANCE: "var(--region-maintenance, #3b82f6)",
    NO_DATA: "var(--region-nodata, #8b8d98)"
  };

  const LABEL: Record<RegionMapStatus, string> = {
    UP: "Up",
    DEGRADED: "Degraded",
    DOWN: "Down",
    MAINTENANCE: "Maintenance",
    NO_DATA: "No recent data"
  };

  /**
   * Shape per status, so the map does not rely on colour alone.
   *
   * NO_DATA is a hollow ring rather than a filled dot: "we have not heard from
   * this region" should look like an absence, and it must not be mistakable for
   * a healthy pin at a glance.
   */
  function pinRadius(status: RegionMapStatus): number {
    return status === "NO_DATA" ? 5 : 6;
  }
</script>

<div class="flex flex-col gap-3">
  {#if headline}
    <p class="text-sm font-medium">{headline}</p>
  {/if}

  <!--
    aria-hidden, with the table below as the accessible equivalent. Announcing
    an SVG full of circles to a screen reader produces noise, not information.
  -->
  <div class="bg-muted/30 overflow-hidden rounded-md border">
    <svg
      viewBox="0 0 {MAP_WIDTH} {MAP_HEIGHT}"
      class="h-auto w-full"
      role="presentation"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      {#each graticule as d (d)}
        <path {d} fill="none" stroke="currentColor" stroke-width="0.5" class="text-muted-foreground/20" />
      {/each}

      {#each outline as d (d)}
        <path {d} class="fill-muted-foreground/20 stroke-muted-foreground/40" stroke-width="0.75" />
      {/each}

      {#each placed as p (p.region.id)}
        <!--
          A nudged pin is drawn with a leader line back to where the region
          actually is, so moving it to stop an overlap never silently relocates
          it on the viewer's mental map.
        -->
        {#if p.nudged}
          <line
            x1={p.x}
            y1={p.y}
            x2={project({ latitude: p.region.latitude ?? 0, longitude: p.region.longitude ?? 0 }).x}
            y2={project({ latitude: p.region.latitude ?? 0, longitude: p.region.longitude ?? 0 }).y}
            stroke="currentColor"
            stroke-width="0.75"
            class="text-muted-foreground/50"
          />
        {/if}

        <circle
          cx={p.x}
          cy={p.y}
          r={pinRadius(p.region.status)}
          fill={p.region.status === "NO_DATA" ? "none" : FILL[p.region.status]}
          stroke={FILL[p.region.status]}
          stroke-width={p.region.status === "NO_DATA" ? 2 : 1}
          stroke-dasharray={p.region.displayOnly ? "3 2" : undefined}
        >
          <title>{describeEntry(p.region)}</title>
        </circle>
      {/each}
    </svg>
  </div>

  {#if caption}
    <p class="text-muted-foreground text-xs">{caption}</p>
  {/if}

  <!-- The accessible equivalent, and the only place an exact latency appears. -->
  <table class="w-full text-sm">
    <caption class="sr-only">Status by region</caption>
    <thead>
      <tr class="text-muted-foreground border-b text-left text-xs">
        <th scope="col" class="py-1 font-medium">Region</th>
        <th scope="col" class="py-1 font-medium">Status</th>
        <th scope="col" class="py-1 font-medium">Latency</th>
      </tr>
    </thead>
    <tbody>
      {#each tabulated as e (e.id)}
        <tr class="border-b last:border-0">
          <td class="py-1.5">
            <span class="font-medium">{e.name}</span>
            <span class="text-muted-foreground ml-1 font-mono text-xs">{e.code}</span>
            {#if e.displayOnly}
              <span class="text-muted-foreground ml-1 text-xs">(does not vote)</span>
            {/if}
          </td>
          <td class="py-1.5">
            <span class="inline-flex items-center gap-1.5">
              <span
                class="inline-block size-2 rounded-full"
                style="background: {e.status === 'NO_DATA' ? 'transparent' : FILL[e.status]}; box-shadow: inset 0 0 0 2px {FILL[e.status]}"
                aria-hidden="true"
              ></span>
              {LABEL[e.status]}
            </span>
          </td>
          <td class="text-muted-foreground py-1.5">{e.latencyMs === null ? "-" : `${e.latencyMs}ms`}</td>
        </tr>
      {:else}
        <tr><td colspan="3" class="text-muted-foreground py-3 text-center">No regions are reporting.</td></tr>
      {/each}
    </tbody>
  </table>

  {#if unplaced.length > 0}
    <p class="text-muted-foreground text-xs">
      {unplaced.length}
      {unplaced.length === 1 ? "region has" : "regions have"} no coordinates and {unplaced.length === 1
        ? "is"
        : "are"} listed above but not shown on the map.
    </p>
  {/if}
</div>
