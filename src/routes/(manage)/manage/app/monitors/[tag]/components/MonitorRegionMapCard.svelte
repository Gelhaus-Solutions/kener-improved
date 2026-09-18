<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import MapIcon from "@lucide/svelte/icons/map";
  import SaveIcon from "@lucide/svelte/icons/save";
  import Loader from "@lucide/svelte/icons/loader";
  import type { MonitorRecord } from "$lib/server/types/db.js";
  import { toast } from "svelte-sonner";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";

  /**
   * B13. Whether this monitor's public page draws the region map.
   *
   * **Its own card rather than a line inside another one.** The coordinates that
   * feed this map were originally buried inside the merge-policy card on the
   * probes screen and were, in practice, unfindable. A setting nobody can locate
   * is a setting that does not exist, so the one that turns the map off says so
   * on the tin.
   */
  interface Props {
    monitor: MonitorRecord;
    /**
     * Sent back untouched. `storeMonitorData` rewrites the whole monitor row, so
     * a card that posts without the current type data would blank it - the same
     * reason `MonitorSharingOptionsCard` takes it.
     */
    typeData: Record<string, unknown>;
  }

  let { monitor = $bindable(), typeData }: Props = $props();

  /** Absent means shown: an existing monitor with regions keeps its map. */
  function parseShown(monitorSettingsJson: string | null): boolean {
    if (!monitorSettingsJson) return true;
    try {
      const settings = JSON.parse(monitorSettingsJson) as { show_region_map?: boolean };
      return settings.show_region_map !== false;
    } catch {
      return true;
    }
  }

  let shown = $state(parseShown(monitor.monitor_settings_json));
  let saving = $state(false);

  async function save() {
    saving = true;
    try {
      let existing: Record<string, unknown> = {};
      if (monitor.monitor_settings_json) {
        try {
          existing = JSON.parse(monitor.monitor_settings_json);
        } catch {
          existing = {};
        }
      }
      // Merged rather than replaced: this card owns one key and must not drop
      // the latency thresholds or the sharing options sitting beside it.
      const merged = { ...existing, show_region_map: shown };

      const response = await fetch(clientResolver(resolve, "/manage/api"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "storeMonitorData",
          data: {
            ...monitor,
            type_data: JSON.stringify(typeData),
            monitor_settings_json: JSON.stringify(merged)
          }
        })
      });
      const result = await response.json();
      if (result.error) throw new Error(result.error);

      monitor.monitor_settings_json = JSON.stringify(merged);
      toast.success(shown ? "The region map will be shown" : "The region map is hidden on this monitor");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      saving = false;
    }
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title class="flex items-center gap-2">
      <MapIcon class="size-5" />
      Region map
    </Card.Title>
    <Card.Description>
      Whether this monitor&rsquo;s public page shows the world map of the regions it is checked from
    </Card.Description>
  </Card.Header>
  <Card.Content>
    <div class="flex items-center justify-between gap-4">
      <div class="flex flex-col gap-1">
        <Label for="show-region-map">Show the region map</Label>
        <p class="text-muted-foreground text-xs">
          A monitor checked from only one place draws no map either way; there is nothing to compare. Region locations
          are set under Probes.
        </p>
      </div>
      <Switch id="show-region-map" bind:checked={shown} />
    </div>
  </Card.Content>
  <Card.Footer class="justify-end">
    <Button disabled={saving} onclick={save}>
      {#if saving}
        <Loader class="mr-2 size-4 animate-spin" />
      {:else}
        <SaveIcon class="mr-2 size-4" />
      {/if}
      Save
    </Button>
  </Card.Footer>
</Card.Root>
