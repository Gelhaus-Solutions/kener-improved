<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import FileSpreadsheetIcon from "@lucide/svelte/icons/file-spreadsheet";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import { toast } from "svelte-sonner";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import { onMount } from "svelte";

  interface MonitorOption {
    tag: string;
    name: string;
    category_name: string | null;
  }
  interface PageOption {
    id: number;
    page_title: string;
    page_path: string;
  }
  interface GrainOption {
    value: string;
    usable: boolean;
    latest_ts: number | null;
  }

  const SCOPE_TYPES = [
    { value: "ALL", label: "Every component" },
    { value: "MONITOR", label: "A single component" },
    { value: "PAGE", label: "Every component on a page" },
    { value: "CATEGORY", label: "Every component in a category" }
  ];

  const GRAIN_LABELS: Record<string, string> = {
    "5m": "5 minutes",
    "1h": "Hourly",
    "1d": "Daily"
  };

  let monitors = $state<MonitorOption[]>([]);
  let pages = $state<PageOption[]>([]);
  let categories = $state<string[]>([]);
  let grains = $state<GrainOption[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  /** Dates are held as `YYYY-MM-DD` strings, which is what a date input speaks. */
  let form = $state({
    scope_type: "ALL",
    scope_ref: "",
    from: "",
    to: "",
    grain: "1d",
    exclude_maintenance: true,
    degraded_counts_as_bad: false
  });

  let scopeOptions = $derived.by(() => {
    if (form.scope_type === "PAGE") {
      return pages.map((page) => ({ value: String(page.id), label: `${page.page_title} (${page.page_path})` }));
    }
    if (form.scope_type === "CATEGORY") {
      return categories.map((name) => ({ value: name, label: name }));
    }
    if (form.scope_type === "MONITOR") {
      return monitors.map((monitor) => ({ value: monitor.tag, label: monitor.name || monitor.tag }));
    }
    return [];
  });

  let needsScopeRef = $derived(form.scope_type !== "ALL");
  let selectedGrain = $derived(grains.find((grain) => grain.value === form.grain));
  let grainUnusable = $derived(selectedGrain !== undefined && !selectedGrain.usable);

  const labelFor = (options: Array<{ value: string; label: string }>, value: string, fallback: string) =>
    options.find((option) => option.value === value)?.label ?? fallback;

  /** `YYYY-MM-DD` to UTC seconds at midnight. */
  function dayToUtcSeconds(day: string): number | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const ms = Date.parse(`${day}T00:00:00Z`);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }

  function utcSecondsToDay(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }

  /**
   * The range is a problem the form can catch before the server has to.
   *
   * Returns the reason it is unusable, or null. Kept as one derived value so the
   * message and the disabled state can never disagree about whether the form is
   * ready.
   */
  let rangeProblem = $derived.by(() => {
    const from = dayToUtcSeconds(form.from);
    const to = dayToUtcSeconds(form.to);
    if (from === null || to === null) return "Choose a start and an end date.";
    if (to <= from) return "The end date must be after the start date.";
    if (to - from > 400 * 86400) return "The range may not exceed 400 days.";
    if (needsScopeRef && form.scope_ref === "") return "Choose what the report should cover.";
    return null;
  });

  /**
   * How far past the chosen end date the data has not been finalised.
   *
   * The export clamps its own range to the rollup watermark, so a report asked
   * for up to today comes back ending a few minutes ago. Saying so here means the
   * shorter range on the PDF cover is expected rather than alarming.
   */
  let clampNotice = $derived.by(() => {
    const to = dayToUtcSeconds(form.to);
    const latest = selectedGrain?.latest_ts ?? null;
    if (to === null || latest === null || to <= latest) return null;
    return `Data is finalised to ${utcSecondsToDay(latest)} (UTC) at this grain, so the report will end there.`;
  });

  async function call(action: string, data: Record<string, unknown>) {
    const res = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    const result = await res.json();
    if (!res.ok || result.error) throw new Error(result.error || `${action} failed`);
    return result;
  }

  async function load() {
    loading = true;
    try {
      const result = await call("getReportOptions", {});
      monitors = result.monitors ?? [];
      pages = result.pages ?? [];
      categories = result.categories ?? [];
      grains = result.grains ?? [];

      // Default to the last full 30 days, ending at the watermark rather than at
      // today, so the first report a new user runs is not silently shortened.
      const daily = grains.find((grain: GrainOption) => grain.value === "1d");
      const end = daily?.latest_ts ?? Math.floor(Date.now() / 1000);
      form.to = utcSecondsToDay(end);
      form.from = utcSecondsToDay(end - 30 * 86400);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load report options";
    } finally {
      loading = false;
    }
  }

  onMount(load);

  /**
   * Starts the download as a plain navigation.
   *
   * Deliberately not `fetch` plus a blob: the CSV can be millions of rows, and
   * building a blob would put the whole file in the tab's memory to hand it to a
   * save dialog the browser can do by itself. A navigation streams to disk.
   */
  function download(format: "csv" | "pdf") {
    if (rangeProblem) {
      toast.error(rangeProblem);
      return;
    }
    const params = new URLSearchParams({
      format,
      scope_type: form.scope_type,
      scope_ref: form.scope_type === "ALL" ? "" : form.scope_ref,
      from: String(dayToUtcSeconds(form.from)),
      to: String(dayToUtcSeconds(form.to)),
      grain: form.grain,
      exclude_maintenance: form.exclude_maintenance ? "1" : "0",
      degraded_counts_as_bad: form.degraded_counts_as_bad ? "1" : "0"
    });
    window.location.href = `${clientResolver(resolve, "/manage/app/reports/export")}?${params.toString()}`;
  }
</script>

<svelte:head>
  <title>Reports</title>
</svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 py-6">
  <div class="mb-6">
    <h1 class="text-2xl font-semibold tracking-tight">Reports</h1>
    <p class="text-muted-foreground mt-1 text-sm">
      Export uptime for any range as a spreadsheet or a PDF. All ranges are UTC, and the end date is exclusive.
    </p>
  </div>

  {#if loading}
    <div class="flex items-center gap-2 py-12">
      <Spinner class="size-4" />
      <span class="text-muted-foreground text-sm">Loading options</span>
    </div>
  {:else if error}
    <Card.Root>
      <Card.Content class="py-8 text-center">
        <p class="text-destructive text-sm">{error}</p>
        <Button variant="outline" size="sm" class="mt-4" onclick={load}>Try again</Button>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root>
      <Card.Header>
        <Card.Title>Uptime report</Card.Title>
        <Card.Description>
          The CSV carries one row per component per bucket, with latency percentiles. The PDF is a summary with SLO
          attainment.
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-5">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="scope-type">Covers</Label>
            <Select.Root
              type="single"
              value={form.scope_type}
              onValueChange={(value) => {
                if (!value) return;
                form.scope_type = value;
                form.scope_ref = "";
              }}
            >
              <Select.Trigger id="scope-type" class="w-full">
                {labelFor(SCOPE_TYPES, form.scope_type, "Choose")}
              </Select.Trigger>
              <Select.Content>
                {#each SCOPE_TYPES as option (option.value)}
                  <Select.Item value={option.value}>{option.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>

          {#if needsScopeRef}
            <div class="space-y-2">
              <Label for="scope-ref">Which one</Label>
              <Select.Root
                type="single"
                value={form.scope_ref}
                onValueChange={(value) => {
                  if (value) form.scope_ref = value;
                }}
              >
                <Select.Trigger id="scope-ref" class="w-full">
                  {labelFor(scopeOptions, form.scope_ref, "Choose")}
                </Select.Trigger>
                <Select.Content>
                  {#each scopeOptions as option (option.value)}
                    <Select.Item value={option.value}>{option.label}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            </div>
          {/if}
        </div>

        <div class="grid gap-4 sm:grid-cols-3">
          <div class="space-y-2">
            <Label for="from">From (UTC)</Label>
            <Input id="from" type="date" bind:value={form.from} />
          </div>
          <div class="space-y-2">
            <Label for="to">To (UTC, exclusive)</Label>
            <Input id="to" type="date" bind:value={form.to} />
          </div>
          <div class="space-y-2">
            <Label for="grain">Detail</Label>
            <Select.Root
              type="single"
              value={form.grain}
              onValueChange={(value) => {
                if (value) form.grain = value;
              }}
            >
              <Select.Trigger id="grain" class="w-full">
                {GRAIN_LABELS[form.grain] ?? form.grain}
              </Select.Trigger>
              <Select.Content>
                {#each grains as grain (grain.value)}
                  <Select.Item value={grain.value} disabled={!grain.usable}>
                    {GRAIN_LABELS[grain.value] ?? grain.value}{grain.usable ? "" : " (not ready)"}
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        </div>

        <div class="space-y-3">
          <div class="flex items-center justify-between gap-4">
            <div class="space-y-0.5">
              <Label for="exclude-maintenance">Exclude announced maintenance</Label>
              <p class="text-muted-foreground text-xs">
                Minutes inside a maintenance window are left out of the calculation entirely.
              </p>
            </div>
            <Switch id="exclude-maintenance" bind:checked={form.exclude_maintenance} />
          </div>
          <div class="flex items-center justify-between gap-4">
            <div class="space-y-0.5">
              <Label for="degraded-bad">Count degraded as unavailable</Label>
              <p class="text-muted-foreground text-xs">
                Off by default, matching how the status page treats a degraded component.
              </p>
            </div>
            <Switch id="degraded-bad" bind:checked={form.degraded_counts_as_bad} />
          </div>
        </div>

        {#if grainUnusable}
          <div class="border-destructive/40 bg-destructive/10 flex gap-2 rounded-md border p-3">
            <TriangleAlertIcon class="text-destructive mt-0.5 size-4 shrink-0" />
            <p class="text-destructive text-xs">
              This level of detail is not available yet: its measurement data is still being built. Choose a coarser
              detail, or try again later.
            </p>
          </div>
        {:else if clampNotice}
          <div class="bg-muted flex gap-2 rounded-md border p-3">
            <TriangleAlertIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <p class="text-muted-foreground text-xs">{clampNotice}</p>
          </div>
        {/if}

        {#if rangeProblem}
          <p class="text-muted-foreground text-xs">{rangeProblem}</p>
        {/if}
      </Card.Content>
      <Card.Footer class="flex flex-wrap gap-2">
        <Button onclick={() => download("csv")} disabled={rangeProblem !== null || grainUnusable}>
          <FileSpreadsheetIcon class="size-4" />
          Download CSV
        </Button>
        <Button variant="outline" onclick={() => download("pdf")} disabled={rangeProblem !== null || grainUnusable}>
          <FileTextIcon class="size-4" />
          Download PDF
        </Button>
      </Card.Footer>
    </Card.Root>
  {/if}
</div>
