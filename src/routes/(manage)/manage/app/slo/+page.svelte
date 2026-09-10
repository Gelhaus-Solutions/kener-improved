<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import TrashIcon from "@lucide/svelte/icons/trash";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import { toast } from "svelte-sonner";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import { onMount } from "svelte";

  interface Evaluation {
    window_start: number;
    window_end: number;
    count_total: number;
    count_good: number;
    count_bad: number;
    count_excluded: number;
    uptime_percent: number | null;
    objective_percent: number;
    budget_total: number | null;
    budget_consumed: number | null;
    budget_remaining_percent: number | null;
    burn_1h: number | null;
    burn_6h: number | null;
    burn_24h: number | null;
    burn_3d: number | null;
    monitor_count: number;
    computed_at: number;
  }
  interface Target {
    id: number;
    name: string;
    scope_type: string;
    scope_ref: string;
    combination: string;
    objective_percent: number;
    window_type: string;
    window_days: number | null;
    calendar_period: string | null;
    exclude_maintenance: string;
    degraded_counts_as_bad: string;
    show_on_public: string;
    status: string;
    evaluation: Evaluation | null;
  }
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

  const SCOPE_TYPES = [
    { value: "MONITOR", label: "A single component" },
    { value: "PAGE", label: "Every component on a page" },
    { value: "CATEGORY", label: "Every component in a category" }
  ];
  const COMBINATIONS = [
    { value: "WORST", label: "Worst: bad if any component is bad" },
    { value: "AVERAGE", label: "Average: pool every component's samples" }
  ];
  const WINDOW_TYPES = [
    { value: "ROLLING", label: "Rolling window" },
    { value: "CALENDAR", label: "Calendar period" }
  ];
  const CALENDAR_PERIODS = [
    { value: "MONTH", label: "Month" },
    { value: "QUARTER", label: "Quarter" },
    { value: "YEAR", label: "Year" }
  ];

  let targets = $state<Target[]>([]);
  let monitors = $state<MonitorOption[]>([]);
  let pages = $state<PageOption[]>([]);
  let categories = $state<string[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let saving = $state(false);

  let dialogOpen = $state(false);
  let editingId = $state<number | null>(null);
  let form = $state({
    name: "",
    scope_type: "MONITOR",
    scope_ref: "",
    combination: "WORST",
    objective_percent: 99.9,
    window_type: "ROLLING",
    window_days: 30,
    calendar_period: "MONTH",
    exclude_maintenance: true,
    degraded_counts_as_bad: false,
    show_on_public: false,
    status: "ACTIVE"
  });

  /** The scope dropdown's options, which depend on which kind of scope is chosen. */
  let scopeOptions = $derived.by(() => {
    if (form.scope_type === "PAGE") {
      return pages.map((page) => ({ value: String(page.id), label: `${page.page_title} (${page.page_path})` }));
    }
    if (form.scope_type === "CATEGORY") {
      return categories.map((name) => ({ value: name, label: name }));
    }
    return monitors.map((monitor) => ({ value: monitor.tag, label: monitor.name || monitor.tag }));
  });

  /** Only meaningful when the scope can resolve to more than one component. */
  let scopeIsMulti = $derived(form.scope_type !== "MONITOR");

  const labelFor = (options: Array<{ value: string; label: string }>, value: string, fallback: string) =>
    options.find((option) => option.value === value)?.label ?? fallback;

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
      const result = await call("getSlaOverview", {});
      targets = result.targets ?? [];
      monitors = result.monitors ?? [];
      pages = result.pages ?? [];
      categories = result.categories ?? [];
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load SLO targets";
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function openCreate() {
    editingId = null;
    form = {
      name: "",
      scope_type: "MONITOR",
      scope_ref: "",
      combination: "WORST",
      objective_percent: 99.9,
      window_type: "ROLLING",
      window_days: 30,
      calendar_period: "MONTH",
      exclude_maintenance: true,
      degraded_counts_as_bad: false,
      show_on_public: false,
      status: "ACTIVE"
    };
    dialogOpen = true;
  }

  function openEdit(target: Target) {
    editingId = target.id;
    form = {
      name: target.name,
      scope_type: target.scope_type,
      scope_ref: target.scope_ref,
      combination: target.combination,
      objective_percent: target.objective_percent,
      window_type: target.window_type,
      window_days: target.window_days ?? 30,
      calendar_period: target.calendar_period ?? "MONTH",
      exclude_maintenance: target.exclude_maintenance === "YES",
      degraded_counts_as_bad: target.degraded_counts_as_bad === "YES",
      show_on_public: target.show_on_public === "YES",
      status: target.status
    };
    dialogOpen = true;
  }

  async function save() {
    saving = true;
    try {
      await call("saveSlaTarget", { ...form, id: editingId });
      toast.success(editingId ? "SLO target updated" : "SLO target created");
      dialogOpen = false;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the target");
    } finally {
      saving = false;
    }
  }

  async function remove(target: Target) {
    if (!confirm(`Delete the SLO target "${target.name}"?`)) return;
    try {
      await call("deleteSlaTarget", { id: target.id });
      toast.success("SLO target deleted");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the target");
    }
  }

  const pct = (value: number | null | undefined, digits = 3) =>
    value === null || value === undefined ? "-" : `${value.toFixed(digits)}%`;

  const burn = (value: number | null | undefined) =>
    value === null || value === undefined ? "-" : value.toFixed(2) + "x";

  /**
   * The window, spelled out. Always says UTC: the evaluation really is computed
   * on UTC boundaries, and a reader who assumes their own timezone would
   * misread a month's attainment by up to a day at each end.
   */
  function windowLabel(target: Target): string {
    if (target.window_type === "CALENDAR") {
      return `Calendar ${(target.calendar_period ?? "MONTH").toLowerCase()} (UTC)`;
    }
    return `Rolling ${target.window_days ?? 30} days (UTC)`;
  }

  function scopeLabel(target: Target): string {
    if (target.scope_type === "PAGE") {
      const page = pages.find((p) => String(p.id) === target.scope_ref);
      return page ? `Page: ${page.page_title}` : `Page ${target.scope_ref}`;
    }
    if (target.scope_type === "CATEGORY") return `Category: ${target.scope_ref}`;
    const monitor = monitors.find((m) => m.tag === target.scope_ref);
    return monitor ? monitor.name || monitor.tag : target.scope_ref;
  }

  /** Green while there is budget left, red once it is overspent. */
  const budgetTone = (value: number | null | undefined) =>
    value === null || value === undefined ? "text-muted-foreground" : value < 0 ? "text-red-600" : "text-green-600";

  /** A burn rate at or above 1 is spending faster than the window allows. */
  const burnTone = (value: number | null | undefined) =>
    value === null || value === undefined ? "text-muted-foreground" : value >= 1 ? "text-red-600" : "";
</script>

<svelte:head><title>SLOs</title></svelte:head>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-semibold">SLOs</h1>
      <p class="text-muted-foreground text-sm">
        Service level objectives, their attainment and how fast the error budget is being spent. Recomputed every five
        minutes from the rollups. Every window is measured in UTC.
      </p>
    </div>
    <Button onclick={openCreate}><PlusIcon class="mr-1 size-4" /> New target</Button>
  </div>

  {#if loading}
    <div class="flex justify-center p-8"><Spinner /></div>
  {:else if error}
    <Card.Root><Card.Content class="p-6 text-red-600">{error}</Card.Content></Card.Root>
  {:else if targets.length === 0}
    <Card.Root>
      <Card.Content class="text-muted-foreground p-8 text-center text-sm">
        No SLO targets yet. A target names a scope, an objective and a window, and everything else is derived from it.
      </Card.Content>
    </Card.Root>
  {:else}
    {#each targets as target (target.id)}
      <Card.Root>
        <Card.Header>
          <div class="flex items-start justify-between gap-4">
            <div>
              <Card.Title class="flex items-center gap-2">
                {target.name}
                {#if target.status !== "ACTIVE"}<Badge variant="secondary">Inactive</Badge>{/if}
                {#if target.show_on_public === "YES"}<Badge variant="outline">Public</Badge>{/if}
              </Card.Title>
              <Card.Description>
                {scopeLabel(target)} &middot; {windowLabel(target)} &middot; objective {target.objective_percent}%
                {#if target.scope_type !== "MONITOR"}
                  &middot; {target.combination === "WORST" ? "worst-case" : "averaged"}
                {/if}
              </Card.Description>
            </div>
            <div class="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" onclick={() => openEdit(target)}>
                <PencilIcon class="size-4" />
              </Button>
              <Button variant="outline" size="sm" onclick={() => remove(target)}>
                <TrashIcon class="size-4" />
              </Button>
            </div>
          </div>
        </Card.Header>
        <Card.Content>
          {#if !target.evaluation}
            <p class="text-muted-foreground text-sm">Not evaluated yet. The scheduler runs every five minutes.</p>
          {:else}
            {@const evaluation = target.evaluation}
            <div class="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <div>
                <div class="text-muted-foreground text-xs">Attainment</div>
                <div class="text-lg font-semibold">{pct(evaluation.uptime_percent)}</div>
              </div>
              <div>
                <div class="text-muted-foreground text-xs">Budget left</div>
                <div class="text-lg font-semibold {budgetTone(evaluation.budget_remaining_percent)}">
                  {pct(evaluation.budget_remaining_percent, 1)}
                </div>
              </div>
              {#each [["1h", evaluation.burn_1h], ["6h", evaluation.burn_6h], ["24h", evaluation.burn_24h], ["3d", evaluation.burn_3d]] as [label, value] (label)}
                <div>
                  <div class="text-muted-foreground text-xs">Burn {label}</div>
                  <div class="font-semibold {burnTone(value as number | null)}">{burn(value as number | null)}</div>
                </div>
              {/each}
            </div>
            <p class="text-muted-foreground mt-3 text-xs">
              {evaluation.count_good.toLocaleString()} good, {evaluation.count_bad.toLocaleString()} bad
              {#if evaluation.count_excluded > 0}
                , {evaluation.count_excluded.toLocaleString()} excluded as maintenance
              {/if}
              &middot; {evaluation.monitor_count} component{evaluation.monitor_count === 1 ? "" : "s"}
              &middot; evaluated {new Date(evaluation.computed_at * 1000).toUTCString()}
            </p>
          {/if}
        </Card.Content>
      </Card.Root>
    {/each}
  {/if}
</div>

<Dialog.Root bind:open={dialogOpen}>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{editingId ? "Edit SLO target" : "New SLO target"}</Dialog.Title>
      <Dialog.Description>
        Attainment is measured over UTC boundaries, whatever timezone the status page is displayed in.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4">
      <div class="space-y-2">
        <Label for="slo-name">Name</Label>
        <Input id="slo-name" bind:value={form.name} placeholder="Checkout API, 99.9% monthly" />
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-2">
          <Label>Scope</Label>
          <Select.Root
            type="single"
            value={form.scope_type}
            onValueChange={(v) => {
              form.scope_type = v ?? "MONITOR";
              // The previous reference names a different kind of thing now, and
              // keeping it would submit a monitor tag as a page id.
              form.scope_ref = "";
            }}
          >
            <Select.Trigger class="w-full">{labelFor(SCOPE_TYPES, form.scope_type, "Choose")}</Select.Trigger>
            <Select.Content>
              {#each SCOPE_TYPES as option (option.value)}
                <Select.Item value={option.value}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="space-y-2">
          <Label>Applies to</Label>
          <Select.Root type="single" value={form.scope_ref} onValueChange={(v) => (form.scope_ref = v ?? "")}>
            <Select.Trigger class="w-full">{labelFor(scopeOptions, form.scope_ref, "Choose")}</Select.Trigger>
            <Select.Content>
              {#each scopeOptions as option (option.value)}
                <Select.Item value={option.value}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      </div>

      {#if scopeIsMulti}
        <div class="space-y-2">
          <Label>How components combine</Label>
          <Select.Root type="single" value={form.combination} onValueChange={(v) => (form.combination = v ?? "WORST")}>
            <Select.Trigger class="w-full">{labelFor(COMBINATIONS, form.combination, "Choose")}</Select.Trigger>
            <Select.Content>
              {#each COMBINATIONS as option (option.value)}
                <Select.Item value={option.value}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          <p class="text-muted-foreground text-xs">
            Averaging can report a healthy figure for a scope that had one component down throughout, so worst-case is
            the default.
          </p>
        </div>
      {/if}

      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-2">
          <Label for="slo-objective">Objective (%)</Label>
          <Input id="slo-objective" type="number" step="0.001" min="0" max="100" bind:value={form.objective_percent} />
        </div>
        <div class="space-y-2">
          <Label>Window</Label>
          <Select.Root
            type="single"
            value={form.window_type}
            onValueChange={(v) => (form.window_type = v ?? "ROLLING")}
          >
            <Select.Trigger class="w-full">{labelFor(WINDOW_TYPES, form.window_type, "Choose")}</Select.Trigger>
            <Select.Content>
              {#each WINDOW_TYPES as option (option.value)}
                <Select.Item value={option.value}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      </div>

      {#if form.window_type === "ROLLING"}
        <div class="space-y-2">
          <Label for="slo-days">Window length (days, UTC)</Label>
          <Input id="slo-days" type="number" min="1" max="365" bind:value={form.window_days} />
        </div>
      {:else}
        <div class="space-y-2">
          <Label>Calendar period (UTC)</Label>
          <Select.Root
            type="single"
            value={form.calendar_period}
            onValueChange={(v) => (form.calendar_period = v ?? "MONTH")}
          >
            <Select.Trigger class="w-full">{labelFor(CALENDAR_PERIODS, form.calendar_period, "Month")}</Select.Trigger>
            <Select.Content>
              {#each CALENDAR_PERIODS as option (option.value)}
                <Select.Item value={option.value}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      {/if}

      <div class="space-y-3 border-t pt-3">
        <div class="flex items-center justify-between gap-4">
          <div>
            <Label>Exclude planned maintenance</Label>
            <p class="text-muted-foreground text-xs">Announced maintenance windows do not spend the budget.</p>
          </div>
          <Switch bind:checked={form.exclude_maintenance} />
        </div>
        <div class="flex items-center justify-between gap-4">
          <div>
            <Label>Degraded counts as a breach</Label>
            <p class="text-muted-foreground text-xs">Off by default: degraded is still serving.</p>
          </div>
          <Switch bind:checked={form.degraded_counts_as_bad} />
        </div>
        <div class="flex items-center justify-between gap-4">
          <div>
            <Label>Show on the public page</Label>
            <p class="text-muted-foreground text-xs">
              Publishes attainment and remaining budget to anyone who can see the component.
            </p>
          </div>
          <Switch bind:checked={form.show_on_public} />
        </div>
        <div class="flex items-center justify-between gap-4">
          <div>
            <Label>Active</Label>
            <p class="text-muted-foreground text-xs">Inactive targets are not evaluated.</p>
          </div>
          <Switch
            checked={form.status === "ACTIVE"}
            onCheckedChange={(checked) => (form.status = checked ? "ACTIVE" : "INACTIVE")}
          />
        </div>
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (dialogOpen = false)}>Cancel</Button>
      <Button onclick={save} disabled={saving}>
        {#if saving}<Spinner class="mr-1 size-4" />{/if}
        {editingId ? "Save changes" : "Create target"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
