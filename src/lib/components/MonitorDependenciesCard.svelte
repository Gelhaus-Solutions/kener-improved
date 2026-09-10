<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import { toast } from "svelte-sonner";
  import TrashIcon from "@lucide/svelte/icons/trash-2";

  interface Edge {
    parent_monitor_tag: string;
    child_monitor_tag: string;
    relation: string;
    propagation: string;
    weight: number;
  }
  interface Setting {
    rollup_mode: string;
    manual_override: string | null;
    manual_override_reason: string | null;
    manual_override_expires_at: number | null;
    show_dependencies: string;
  }

  interface Props {
    monitorTag: string;
    /** GROUP monitors compute their own status; the rollup deliberately skips them. */
    isGroup?: boolean;
  }

  let { monitorTag, isGroup = false }: Props = $props();

  let children = $state<Edge[]>([]);
  let parents = $state<Edge[]>([]);
  let setting = $state<Setting | null>(null);
  let loading = $state(true);
  let saving = $state(false);

  let newChild = $state("");
  let newPropagation = $state("WORST");
  let newWeight = $state("1");

  const ROLLUP_MODES = [
    { value: "NONE", label: "Report only itself" },
    { value: "WORST", label: "Inherit its worst child" },
    { value: "WEIGHTED", label: "Weighted across children" }
  ];
  const PROPAGATIONS = [
    { value: "WORST", label: "Propagates" },
    { value: "WEIGHTED", label: "Weighted" },
    { value: "NONE", label: "Recorded only" }
  ];
  const IMPACTS = [
    { value: "", label: "No pin" },
    { value: "OPERATIONAL", label: "Operational" },
    { value: "UNDER_MAINTENANCE", label: "Under Maintenance" },
    { value: "DEGRADED_PERFORMANCE", label: "Degraded Performance" },
    { value: "PARTIAL_OUTAGE", label: "Partial Outage" },
    { value: "MAJOR_OUTAGE", label: "Major Outage" }
  ];

  let overrideValue = $state("");
  let overrideReason = $state("");
  let overrideHours = $state("");
  // A monitor with edges but no settings row is the common case, and it should
  // show its graph. Absent therefore means yes, exactly as the column default says.
  let showPublicly = $state(true);

  async function call(action: string, data: Record<string, unknown>) {
    const res = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    const result = await res.json();
    if (!res.ok || result.error) throw new Error(result.error || "Request failed");
    return result;
  }

  async function load() {
    loading = true;
    try {
      const result = await call("getMonitorDependencies", { monitor_tag: monitorTag });
      children = result.children ?? [];
      parents = result.parents ?? [];
      setting = result.setting ?? null;
      overrideValue = setting?.manual_override ?? "";
      overrideReason = setting?.manual_override_reason ?? "";
      showPublicly = (setting?.show_dependencies ?? "YES") !== "NO";
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load dependencies");
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (monitorTag) load();
  });

  async function addChild() {
    if (!newChild.trim()) return;
    saving = true;
    try {
      await call("setMonitorDependency", {
        parent_monitor_tag: monitorTag,
        child_monitor_tag: newChild.trim(),
        relation: "CONTAINS",
        propagation: newPropagation,
        weight: Number(newWeight) || 1
      });
      newChild = "";
      await load();
      toast.success("Dependency saved");
    } catch (e) {
      // The cycle check lives on the server and its message names both ends, so
      // it is worth showing verbatim rather than replacing with something vague.
      toast.error(e instanceof Error ? e.message : "Could not save the dependency");
    } finally {
      saving = false;
    }
  }

  async function removeChild(edge: Edge) {
    saving = true;
    try {
      await call("deleteMonitorDependency", {
        parent_monitor_tag: edge.parent_monitor_tag,
        child_monitor_tag: edge.child_monitor_tag,
        relation: edge.relation
      });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the dependency");
    } finally {
      saving = false;
    }
  }

  async function saveRollup(mode: string) {
    saving = true;
    try {
      await call("setMonitorRollup", {
        monitor_tag: monitorTag,
        rollup_mode: mode,
        manual_override: overrideValue || null,
        manual_override_reason: overrideReason || null,
        manual_override_hours: overrideHours ? Number(overrideHours) : null,
        show_dependencies: showPublicly
      });
      await load();
      toast.success("Rollup settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the settings");
    } finally {
      saving = false;
    }
  }

  const expiryText = (at: number | null) =>
    at === null ? "does not expire" : `expires ${new Date(at * 1000).toLocaleString()}`;
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Dependencies</Card.Title>
    <Card.Description>
      What this component is made of, and what it should report when a part of it fails. This changes what the status
      page shows; it does not change this monitor's own check or its uptime history.
    </Card.Description>
  </Card.Header>
  <Card.Content class="flex flex-col gap-6">
    {#if loading}
      <p class="text-muted-foreground text-sm">Loading...</p>
    {:else}
      {#if isGroup}
        <p class="text-muted-foreground rounded-md border p-3 text-xs">
          This is a group monitor, so it already works out its own status from its members every time it runs. Its
          dependencies are recorded here for the graph view, but they are not rolled up a second time.
        </p>
      {/if}

      <!-- Rollup mode -->
      <div class="flex flex-col gap-2">
        <Label>When a child fails</Label>
        <select
          class="border-input bg-background h-9 rounded-md border px-2 text-sm"
          value={setting?.rollup_mode ?? "NONE"}
          disabled={saving}
          onchange={(e) => saveRollup(e.currentTarget.value)}
        >
          {#each ROLLUP_MODES as mode (mode.value)}
            <option value={mode.value}>{mode.label}</option>
          {/each}
        </select>
      </div>

      <!-- What the public page is allowed to say about the graph -->
      <div class="flex items-start justify-between gap-4 rounded-md border p-3">
        <div class="flex flex-col gap-1">
          <Label for="show-dependencies">Show these on the public page</Label>
          <p class="text-muted-foreground text-xs">
            Names this component's dependencies on its status page, and says which one a rolled-up status came from.
            Turning it off hides the names only: the rollup still moves the status, because that is what the status page
            already reports. Dependencies that are hidden or inactive monitors are never named either way.
          </p>
        </div>
        <Switch
          id="show-dependencies"
          checked={showPublicly}
          disabled={saving}
          aria-label="Show dependencies on the public page"
          onCheckedChange={(checked) => {
            showPublicly = checked;
            saveRollup(setting?.rollup_mode ?? "NONE");
          }}
        />
      </div>

      <!-- Children -->
      <div class="flex flex-col gap-2">
        <Label>Depends on</Label>
        {#if children.length === 0}
          <p class="text-muted-foreground text-sm">Nothing yet.</p>
        {:else}
          <div class="flex flex-col gap-2">
            {#each children as edge (edge.child_monitor_tag + edge.relation)}
              <div class="flex items-center justify-between rounded-md border p-2">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-sm">{edge.child_monitor_tag}</span>
                  <Badge variant={edge.propagation === "NONE" ? "outline" : "secondary"}>
                    {PROPAGATIONS.find((p) => p.value === edge.propagation)?.label ?? edge.propagation}
                  </Badge>
                  {#if edge.propagation === "WEIGHTED"}
                    <span class="text-muted-foreground text-xs">weight {edge.weight}</span>
                  {/if}
                </div>
                <Button size="sm" variant="ghost" disabled={saving} onclick={() => removeChild(edge)}>
                  <TrashIcon class="size-4" />
                </Button>
              </div>
            {/each}
          </div>
        {/if}

        <div class="flex flex-wrap items-end gap-2">
          <div class="flex min-w-40 flex-1 flex-col gap-1">
            <Label class="text-xs">Monitor tag</Label>
            <Input bind:value={newChild} placeholder="api-gateway" />
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">How it propagates</Label>
            <select class="border-input bg-background h-9 rounded-md border px-2 text-sm" bind:value={newPropagation}>
              {#each PROPAGATIONS as p (p.value)}
                <option value={p.value}>{p.label}</option>
              {/each}
            </select>
          </div>
          {#if newPropagation === "WEIGHTED"}
            <div class="flex w-24 flex-col gap-1">
              <Label class="text-xs">Weight</Label>
              <Input bind:value={newWeight} type="number" min="0" step="0.1" />
            </div>
          {/if}
          <Button onclick={addChild} disabled={saving || !newChild.trim()}>Add</Button>
        </div>
      </div>

      <!-- Parents, read only: they are edited from the other end -->
      {#if parents.length > 0}
        <div class="flex flex-col gap-2">
          <Label>Used by</Label>
          <div class="flex flex-wrap gap-2">
            {#each parents as edge (edge.parent_monitor_tag + edge.relation)}
              <Badge variant="outline" class="font-mono">{edge.parent_monitor_tag}</Badge>
            {/each}
          </div>
          <p class="text-muted-foreground text-xs">Edit these from the component that depends on this one.</p>
        </div>
      {/if}

      <!-- The pin -->
      <div class="flex flex-col gap-2 rounded-md border p-3">
        <Label>Pin this component's status</Label>
        <p class="text-muted-foreground text-xs">
          Overrides whatever rolls up. Separate from an incident's impact: this one has no incident behind it and
          outlives any single one, which is why it should be given an expiry.
        </p>
        <div class="flex flex-wrap items-end gap-2">
          <div class="flex min-w-44 flex-col gap-1">
            <Label class="text-xs">Status</Label>
            <select class="border-input bg-background h-9 rounded-md border px-2 text-sm" bind:value={overrideValue}>
              {#each IMPACTS as impact (impact.value)}
                <option value={impact.value}>{impact.label}</option>
              {/each}
            </select>
          </div>
          {#if overrideValue}
            <div class="flex min-w-40 flex-1 flex-col gap-1">
              <Label class="text-xs">Reason</Label>
              <Input bind:value={overrideReason} placeholder="Failover in progress" />
            </div>
            <div class="flex w-28 flex-col gap-1">
              <Label class="text-xs">Hours</Label>
              <Input bind:value={overrideHours} type="number" min="0" step="1" placeholder="24" />
            </div>
          {/if}
          <Button variant="outline" disabled={saving} onclick={() => saveRollup(setting?.rollup_mode ?? "NONE")}>
            Save
          </Button>
        </div>
        {#if setting?.manual_override}
          <p class="text-xs">
            Pinned to <span class="font-medium">{setting.manual_override}</span>, {expiryText(
              setting.manual_override_expires_at
            )}.
          </p>
        {/if}
      </div>
    {/if}
  </Card.Content>
</Card.Root>
