<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import SaveIcon from "@lucide/svelte/icons/save";
  import Loader from "@lucide/svelte/icons/loader";
  import type { MonitorRecord } from "$lib/server/types/db.js";
  import { toast } from "svelte-sonner";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";

  /**
   * Latency-based DEGRADED for one monitor (B5).
   *
   * The rule is evaluated at check time and escalates the *observed* status, so
   * the monitor's ordinary confirmation threshold damps it exactly like any
   * other flip. That is why the copy below talks about confirmation rather than
   * about any anti-flap setting of its own: there isn't one.
   */
  interface Props {
    monitor: MonitorRecord;
    typeData: Record<string, unknown>;
  }

  // `monitor` is bindable because saving updates `monitor_settings_json` in
  // place, and the parent holds the copy every other card reads to merge into.
  let { monitor = $bindable(), typeData }: Props = $props();

  const MODES = [
    { value: "INHERIT", label: "Use the site default" },
    { value: "CUSTOM", label: "Use settings below" },
    { value: "OFF", label: "Never (ignore the site default)" }
  ];
  const METRICS = [
    { value: "p50", label: "p50 (median)" },
    { value: "p90", label: "p90" },
    { value: "p95", label: "p95" },
    { value: "p99", label: "p99" },
    { value: "avg", label: "Average" }
  ];

  function readSettings(): Record<string, unknown> {
    if (!monitor.monitor_settings_json) return {};
    try {
      return JSON.parse(monitor.monitor_settings_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  const stored = (readSettings().latency_threshold ?? {}) as Record<string, unknown>;

  let form = $state({
    mode: (typeof stored.mode === "string" ? stored.mode : "INHERIT") as string,
    metric: (typeof stored.metric === "string" ? stored.metric : "p95") as string,
    window_minutes: Number(stored.window_minutes ?? 5),
    min_samples: Number(stored.min_samples ?? 3),
    degraded_ms: Number(stored.degraded_ms ?? 1000),
    // Empty means "latency can never make this monitor DOWN", which is a real
    // choice and the default one, so it is not the same as zero.
    down_ms: stored.down_ms == null ? "" : String(stored.down_ms)
  });

  let saving = $state(false);
  let isCustom = $derived(form.mode === "CUSTOM");

  const labelFor = (options: Array<{ value: string; label: string }>, value: string) =>
    options.find((o) => o.value === value)?.label ?? value;

  async function save() {
    if (isCustom) {
      if (!(form.degraded_ms > 0)) {
        toast.error("The degraded threshold must be greater than 0ms");
        return;
      }
      if (form.down_ms !== "" && Number(form.down_ms) <= form.degraded_ms) {
        toast.error("The down threshold must be higher than the degraded threshold");
        return;
      }
    }

    saving = true;
    try {
      // Merged, never replaced: this card owns one key of monitor_settings_json.
      const existing = readSettings();
      const latency_threshold = isCustom
        ? {
            mode: "CUSTOM",
            enabled: true,
            metric: form.metric,
            window_minutes: Number(form.window_minutes),
            min_samples: Number(form.min_samples),
            degraded_ms: Number(form.degraded_ms),
            down_ms: form.down_ms === "" ? null : Number(form.down_ms)
          }
        : { mode: form.mode };

      const payload = {
        ...monitor,
        type_data: JSON.stringify(typeData),
        monitor_settings_json: JSON.stringify({ ...existing, latency_threshold })
      };

      const response = await fetch(clientResolver(resolve, "/manage/api"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "storeMonitorData", data: payload })
      });
      const result = await response.json();
      if (result.error) toast.error(result.error);
      else {
        monitor.monitor_settings_json = payload.monitor_settings_json;
        toast.success("Latency threshold saved");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save the latency threshold");
    } finally {
      saving = false;
    }
  }
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Latency Threshold</Card.Title>
    <Card.Description>
      Report this monitor as degraded when it is slow, even while it is still answering. The verdict goes through the
      monitor's confirmation threshold like any other status change, so one slow check cannot move the page.
    </Card.Description>
  </Card.Header>
  <Card.Content class="space-y-4">
    <div class="flex flex-col gap-2">
      <Label>When to apply</Label>
      <Select.Root type="single" value={form.mode} onValueChange={(v) => v && (form.mode = v)}>
        <Select.Trigger class="w-full">{labelFor(MODES, form.mode)}</Select.Trigger>
        <Select.Content>
          {#each MODES as option (option.value)}
            <Select.Item value={option.value}>{option.label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>

    {#if isCustom}
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="flex flex-col gap-2">
          <Label>Metric</Label>
          <Select.Root type="single" value={form.metric} onValueChange={(v) => v && (form.metric = v)}>
            <Select.Trigger class="w-full">{labelFor(METRICS, form.metric)}</Select.Trigger>
            <Select.Content>
              {#each METRICS as option (option.value)}
                <Select.Item value={option.value}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="flex flex-col gap-2">
          <Label for="lt-window">Window (minutes)</Label>
          <Input id="lt-window" type="number" min="1" bind:value={form.window_minutes} />
        </div>
        <div class="flex flex-col gap-2">
          <Label for="lt-min">Minimum samples</Label>
          <Input id="lt-min" type="number" min="1" bind:value={form.min_samples} />
          <p class="text-muted-foreground text-xs">
            Below this many usable measurements in the window, no verdict is reached at all.
          </p>
        </div>
        <div class="flex flex-col gap-2">
          <Label for="lt-degraded">Degraded above (ms)</Label>
          <Input id="lt-degraded" type="number" min="1" bind:value={form.degraded_ms} />
        </div>
        <div class="flex flex-col gap-2 sm:col-span-2">
          <Label for="lt-down">Down above (ms)</Label>
          <Input id="lt-down" type="number" min="1" placeholder="Leave empty" bind:value={form.down_ms} />
          <p class="text-muted-foreground text-xs">
            Optional. Leave empty and latency can never make this monitor down, only degraded.
          </p>
        </div>
      </div>
      <p class="text-muted-foreground text-xs">
        Timed-out and errored checks are never measured: their latency is how long we waited before giving up, not how
        long the service took.
      </p>
    {/if}

    <div class="flex justify-end">
      <Button onclick={save} disabled={saving}>
        {#if saving}<Loader class="mr-1 size-4 animate-spin" />{:else}<SaveIcon class="mr-1 size-4" />{/if}
        Save
      </Button>
    </div>
  </Card.Content>
</Card.Root>
