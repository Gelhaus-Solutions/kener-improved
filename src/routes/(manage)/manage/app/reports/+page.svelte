<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import FileSpreadsheetIcon from "@lucide/svelte/icons/file-spreadsheet";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import ActivityIcon from "@lucide/svelte/icons/activity";
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
  interface Measure {
    key: string;
    label: string;
    mean: number | null;
    median: number | null;
    max: number | null;
    sampleCount: number;
  }
  interface IncidentReport {
    window: { from: number; to: number; bucket: string; timezone: string };
    incident_count: number;
    basis: { alert: number; reported: number };
    measures: Measure[];
    by_severity: Array<{ severity: string; count: number }>;
    by_component: Array<{ monitorTag: string; count: number }>;
    trend: Array<{ bucketStart: number; incidentCount: number; mttrMedian: number | null }>;
    truncated: boolean;
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

  let incidentReport = $state<IncidentReport | null>(null);
  let incidentLoading = $state(false);
  let incidentError = $state<string | null>(null);

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

  /** Seconds as a compact human duration. Mirrors the PDF's own formatting. */
  function durationText(seconds: number | null): string {
    if (seconds === null) return "n/a";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  /**
   * Loads the incident metrics for the chosen range.
   *
   * Explicit rather than reactive: this can scan a day of samples per incident
   * to find each one's true outage start, so it runs when asked rather than on
   * every keystroke in the date field.
   */
  async function loadIncidentMetrics() {
    if (rangeProblem) {
      toast.error(rangeProblem);
      return;
    }
    incidentLoading = true;
    incidentError = null;
    try {
      incidentReport = await call("getIncidentReport", {
        scope_type: form.scope_type,
        scope_ref: form.scope_type === "ALL" ? "" : form.scope_ref,
        from: dayToUtcSeconds(form.from),
        to: dayToUtcSeconds(form.to)
      });
    } catch (e) {
      incidentError = e instanceof Error ? e.message : "Could not load incident metrics";
      incidentReport = null;
    } finally {
      incidentLoading = false;
    }
  }

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

    <Card.Root class="mt-6">
      <Card.Header>
        <Card.Title>Incident response</Card.Title>
        <Card.Description>
          How quickly incidents in this range were detected, acknowledged and resolved. The median is shown beside the
          mean because a single long incident moves one and not the other.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {#if incidentLoading}
          <div class="flex items-center gap-2 py-6">
            <Spinner class="size-4" />
            <span class="text-muted-foreground text-sm">Measuring incidents</span>
          </div>
        {:else if incidentError}
          <p class="text-destructive text-sm">{incidentError}</p>
        {:else if !incidentReport}
          <p class="text-muted-foreground text-sm">
            Choose a range above, then load the metrics. This reads raw samples to find when each incident really
            started, so it is not run automatically.
          </p>
        {:else if incidentReport.incident_count === 0}
          <p class="text-muted-foreground text-sm">No incidents started in this range.</p>
        {:else}
          <div class="space-y-4">
            <div class="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span
                ><span class="text-foreground font-medium">{incidentReport.incident_count}</span>
                incident{incidentReport.incident_count === 1 ? "" : "s"}</span
              >
              <span>{incidentReport.basis.alert} detected by a monitor</span>
              <span>{incidentReport.basis.reported} opened by hand</span>
              <span>bucketed by {incidentReport.window.bucket} (UTC)</span>
            </div>

            {#if incidentReport.truncated}
              <div class="border-destructive/40 bg-destructive/10 flex gap-2 rounded-md border p-3">
                <TriangleAlertIcon class="text-destructive mt-0.5 size-4 shrink-0" />
                <p class="text-destructive text-xs">
                  There were more incidents in this range than one report examines, so these figures cover only the
                  earliest of them. Narrow the range for a complete answer.
                </p>
              </div>
            {/if}

            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-muted-foreground border-b text-left text-xs">
                    <th class="py-2 pr-4 font-medium">MEASURE</th>
                    <th class="py-2 pr-4 text-right font-medium">MEAN</th>
                    <th class="py-2 pr-4 text-right font-medium">MEDIAN</th>
                    <th class="py-2 pr-4 text-right font-medium">SLOWEST</th>
                    <th class="py-2 text-right font-medium">INCIDENTS</th>
                  </tr>
                </thead>
                <tbody>
                  {#each incidentReport.measures as measure (measure.key)}
                    <tr class="border-b last:border-0">
                      <td class="py-2 pr-4">{measure.label}</td>
                      <td class="py-2 pr-4 text-right tabular-nums">{durationText(measure.mean)}</td>
                      <td class="py-2 pr-4 text-right font-medium tabular-nums">{durationText(measure.median)}</td>
                      <td class="text-muted-foreground py-2 pr-4 text-right tabular-nums">
                        {durationText(measure.max)}
                      </td>
                      <!-- Printed per measure, not once: an incident nobody
                           acknowledged is excluded from acknowledgement rather
                           than counted as instant, so this column is often
                           smaller than the incident count above. -->
                      <td
                        class="py-2 text-right tabular-nums {measure.sampleCount === 0 ? 'text-muted-foreground' : ''}"
                        >{measure.sampleCount}</td
                      >
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            {#if incidentReport.by_severity.length > 0}
              <div class="flex flex-wrap gap-2">
                {#each incidentReport.by_severity as row (row.severity)}
                  <Badge variant="secondary">{row.severity}: {row.count}</Badge>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </Card.Content>
      <Card.Footer>
        <Button variant="outline" onclick={loadIncidentMetrics} disabled={incidentLoading || rangeProblem !== null}>
          <ActivityIcon class="size-4" />
          {incidentReport ? "Refresh" : "Load"} incident metrics
        </Button>
      </Card.Footer>
    </Card.Root>
  {/if}
</div>
