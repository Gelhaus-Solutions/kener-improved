<script lang="ts">
  import { Label } from "$lib/components/ui/label/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import XIcon from "@lucide/svelte/icons/x";
  import { toast } from "svelte-sonner";
  import { onMount } from "svelte";
  import clientResolver from "$lib/client/resolver.js";
  import { resolve } from "$app/paths";

  // B12c. One service, several regional endpoints.
  //
  // **The endpoints are NOT in `type_data`.** They are rows in
  // `monitor_region_targets`, each backed by a hidden monitor that does the
  // actual checking, so this component saves them through their own action
  // rather than through the monitor form. That is B12a's whole point:
  // `monitoring_data` is keyed by monitor tag, so a regional endpoint has to BE
  // a monitor or the largest table in the schema needs a fourth key column.
  //
  // What IS in `type_data` is the configuration every endpoint shares.

  interface Endpoint {
    region_id: number;
    region_code: string;
    region_name: string;
    child_tag: string;
    address: string;
    missing: boolean;
  }
  interface DeployableRegion {
    id: number;
    code: string;
    name: string;
  }

  let { data = $bindable({} as Record<string, unknown>), tag = "" }: { data: Record<string, unknown>; tag: string } =
    $props();

  const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "HEAD", "DELETE", "OPTIONS"];
  const DEFAULT_TIMEOUT_MS = 10000;

  // Bound rather than inlined: an attribute containing `{` is parsed by Svelte
  // as an expression, so a JavaScript example cannot be written literally here.
  const EVAL_PLACEHOLDER =
    "(statusCode, responseTime, responseRaw) => ({ status: statusCode === 200 ? 'UP' : 'DOWN', latency: responseTime })";

  // The shared half. `endpointType` says what kind of check every endpoint is;
  // only API is supported so far, so it is set rather than offered.
  if (typeof data.endpointType !== "string") data.endpointType = "API";
  if (typeof data.method !== "string") data.method = "GET";
  if (typeof data.timeout !== "number") data.timeout = DEFAULT_TIMEOUT_MS;
  if (!Array.isArray(data.headers)) data.headers = [];

  let endpoints = $state<Endpoint[]>([]);
  let deployableRegions = $state<DeployableRegion[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let loadError = $state<string | null>(null);

  const headers = $derived(data.headers as Array<{ key: string; value: string }>);

  /** Regions not already used, so the same region cannot be added twice. */
  const availableRegions = $derived(
    deployableRegions.filter((region) => !endpoints.some((endpoint) => endpoint.region_id === region.id))
  );

  async function call(action: string, payload: Record<string, unknown>) {
    const res = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data: payload })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || body?.message || "Request failed");
    return body;
  }

  async function load() {
    loading = true;
    try {
      const result = await call("getMultiRegionEndpoints", { monitor_tag: tag });
      endpoints = result.endpoints ?? [];
      deployableRegions = result.deployable_regions ?? [];
      loadError = null;
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Could not load the regional endpoints";
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function addRegion(regionId: number) {
    const region = deployableRegions.find((r) => r.id === regionId);
    if (!region) return;
    endpoints = [
      ...endpoints,
      {
        region_id: region.id,
        region_code: region.code,
        region_name: region.name,
        // Filled in by the server once saved; it is derived from the tag and the
        // region code and is never parsed back to find out which region this is.
        child_tag: "",
        address: "",
        missing: false
      }
    ];
  }

  function removeRegion(regionId: number) {
    endpoints = endpoints.filter((endpoint) => endpoint.region_id !== regionId);
  }

  async function saveEndpoints() {
    saving = true;
    try {
      const result = await call("setMultiRegionEndpoints", {
        monitor_tag: tag,
        endpoints: endpoints.map((endpoint) => ({ region_id: endpoint.region_id, address: endpoint.address }))
      });
      // Reloaded rather than trusted: the server decides the endpoint tags, and
      // a removal that deactivated a monitor is worth seeing reflected.
      await load();
      toast.success(
        `Saved. ${result.created} added, ${result.updated} updated, ${result.removed} removed.`.replace(/\s+/g, " ")
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the regional endpoints");
    } finally {
      saving = false;
    }
  }

  function addHeader() {
    data.headers = [...headers, { key: "", value: "" }];
  }
  function removeHeader(index: number) {
    data.headers = headers.filter((_, i) => i !== index);
  }
</script>

<div class="flex flex-col gap-6">
  <div class="bg-muted/40 rounded-md border p-3 text-sm">
    <p class="font-medium">One service, checked in several places.</p>
    <p class="text-muted-foreground mt-1 text-xs">
      Each region below is checked separately with the shared settings underneath. The service&rsquo;s own status
      follows a fixed rule: every region up is <b>up</b>, some down is <b>degraded</b>, all down is <b>down</b>. There
      is nothing to weight or configure. A region that stops reporting is <b>not</b> treated as down, and alerts fire for
      the service as a whole rather than once per region.
    </p>
  </div>

  <!-- The endpoints. Saved on their own, because they are rows and monitors
       rather than fields on this form. -->
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <Label>Regional endpoints</Label>
      {#if !loading}
        <Badge variant="outline">{endpoints.length}</Badge>
      {/if}
    </div>

    {#if loading}
      <p class="text-muted-foreground text-xs">Loading&hellip;</p>
    {:else if loadError}
      <p class="text-destructive text-xs">{loadError}</p>
    {:else}
      {#if endpoints.length === 0}
        <p class="text-muted-foreground text-xs">
          No regions yet. A multi-region service with no endpoints reports nothing at all, rather than up or down.
        </p>
      {/if}

      {#each endpoints as endpoint (endpoint.region_id)}
        <div class="flex flex-wrap items-end gap-2 rounded-md border p-2">
          <div class="min-w-32 flex-1">
            <p class="text-sm font-medium break-all">{endpoint.region_name}</p>
            <p class="text-muted-foreground text-xs break-all">
              {endpoint.region_code}{#if endpoint.child_tag}&nbsp;&middot;&nbsp;{endpoint.child_tag}{/if}
            </p>
          </div>
          <div class="flex min-w-64 flex-[3] flex-col gap-1">
            <Label for={`mr-address-${endpoint.region_id}`} class="text-xs">URL</Label>
            <Input
              id={`mr-address-${endpoint.region_id}`}
              placeholder="https://eu.example.com/health"
              bind:value={endpoint.address}
            />
          </div>
          {#if endpoint.missing}
            <Badge variant="destructive">not being checked</Badge>
          {/if}
          <Button variant="ghost" size="sm" title="Remove this region" onclick={() => removeRegion(endpoint.region_id)}>
            <XIcon class="size-4" />
          </Button>
        </div>
      {/each}

      <div class="flex flex-wrap items-center gap-2">
        {#if availableRegions.length > 0}
          <Select.Root type="single" value="" onValueChange={(v) => v && addRegion(Number(v))}>
            <Select.Trigger class="w-56">
              <PlusIcon class="mr-1 size-4" /> Add a region
            </Select.Trigger>
            <Select.Content>
              {#each availableRegions as region (region.id)}
                <Select.Item value={String(region.id)}>{region.name} ({region.code})</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        {:else if deployableRegions.length === 0}
          <p class="text-muted-foreground text-xs">
            No region is marked as somewhere a service can be deployed. Set that on the Probes screen: a region can be
            somewhere checks run <i>from</i>, somewhere a service is deployed <i>in</i>, or both.
          </p>
        {:else}
          <p class="text-muted-foreground text-xs">Every deployable region already has an endpoint.</p>
        {/if}

        <Button size="sm" disabled={saving} onclick={saveEndpoints}>
          {saving ? "Saving…" : "Save endpoints"}
        </Button>
      </div>
      <p class="text-muted-foreground text-xs">
        Removing a region stops checking it and keeps its history. Adding it back later picks that history up again.
      </p>
    {/if}
  </div>

  <!-- The shared half, which IS part of the monitor form and saves with it. -->
  <div class="flex flex-col gap-4 border-t pt-4">
    <div>
      <Label>Shared request settings</Label>
      <p class="text-muted-foreground mt-1 text-xs">Every region above is checked with these.</p>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <div class="flex flex-col gap-1">
        <Label for="mr-method">Method</Label>
        <Select.Root type="single" value={String(data.method)} onValueChange={(v) => v && (data.method = v)}>
          <Select.Trigger id="mr-method">{String(data.method)}</Select.Trigger>
          <Select.Content>
            {#each HTTP_METHODS as method (method)}
              <Select.Item value={method}>{method}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex flex-col gap-1">
        <Label for="mr-timeout">Timeout (ms)</Label>
        <Input id="mr-timeout" type="number" min="1" bind:value={data.timeout} />
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <Label>Headers</Label>
        <Button variant="outline" size="sm" onclick={addHeader}>
          <PlusIcon class="mr-1 size-4" /> Add
        </Button>
      </div>
      {#each headers as header, index (index)}
        <div class="flex flex-wrap items-center gap-2">
          <Input class="min-w-32 flex-1" placeholder="Header" bind:value={header.key} />
          <Input class="min-w-32 flex-[2]" placeholder="Value" bind:value={header.value} />
          <Button variant="ghost" size="sm" onclick={() => removeHeader(index)}>
            <XIcon class="size-4" />
          </Button>
        </div>
      {/each}
    </div>

    <div class="flex flex-col gap-1">
      <Label for="mr-eval">Custom eval function</Label>
      <Textarea
        id="mr-eval"
        rows={4}
        placeholder={EVAL_PLACEHOLDER}
        value={String(data.eval ?? "")}
        oninput={(e) => (data.eval = e.currentTarget.value)}
      />
      <p class="text-muted-foreground text-xs">Optional. Applied to every region identically.</p>
    </div>
  </div>
</div>
