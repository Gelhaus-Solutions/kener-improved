<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import TrashIcon from "@lucide/svelte/icons/trash";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import KeyRoundIcon from "@lucide/svelte/icons/key-round";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import { toast } from "svelte-sonner";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import { onMount } from "svelte";

  // H1. Inbound alert webhooks: somebody else's monitoring opens Kener's
  // incidents.
  //
  // The thing this screen has to make legible is the *mapping*, because it is
  // where an endpoint silently does nothing. A receiver that authenticates
  // perfectly and matches no rule records the alert and opens no incident, which
  // looks identical to a receiver nobody is posting to. So every endpoint says
  // out loud when it last heard anything, and every alert row says which
  // component it landed on or that it landed on none.

  interface MappingRule {
    label: string;
    equals: string;
    monitor_tag: string;
  }

  interface Endpoint {
    id: number;
    name: string;
    provider: string;
    token_hint: string | null;
    status: string;
    default_monitor_tag: string | null;
    mapping_rules: MappingRule[];
    default_impact: string | null;
    default_severity: string | null;
    auto_resolve: boolean;
    last_request_at: number | null;
    last_success_at: number | null;
    last_failure_at: number | null;
    last_error: string | null;
  }

  interface Alert {
    id: number;
    endpoint_id: number;
    fingerprint: string;
    status: string;
    monitor_tag: string | null;
    incident_id: number | null;
    severity: string | null;
    title: string | null;
    last_seen_at: number;
    notification_count: number;
  }

  interface PickableMonitor {
    tag: string;
    name: string;
  }

  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);

  let endpoints = $state<Endpoint[]>([]);
  let alerts = $state<Alert[]>([]);
  let monitors = $state<PickableMonitor[]>([]);
  let providers = $state<string[]>([]);
  let templatedProviders = $state<string[]>([]);
  let impacts = $state<string[]>([]);
  let severities = $state<string[]>([]);
  let origin = $state("");

  /**
   * The create dialog, in one of its two phases.
   *
   * One dialog rather than two, the same correctness decision the probes screen
   * documents: closing one overlay while opening another can leave a dimmed
   * layer behind that swallows every click. Swapping the content of a dialog
   * that never closes makes that impossible to reintroduce.
   */
  type CreateDialog = { mode: "form" } | { mode: "token"; token: string; forName: string };
  let createDialog = $state<CreateDialog | null>(null);

  let createName = $state("");
  let createProvider = $state("ALERTMANAGER");
  let createMonitor = $state("");

  let editing = $state<Endpoint | null>(null);
  let editName = $state("");
  let editMonitor = $state("");
  let editImpact = $state("");
  let editSeverity = $state("");
  let editAutoResolve = $state(true);
  let editRules = $state<MappingRule[]>([]);

  let confirmingDelete = $state<Endpoint | null>(null);

  let canCreate = $derived(createName.trim().length > 0 && createProvider.length > 0);

  function alertsFor(endpointId: number): Alert[] {
    return alerts.filter((alert) => alert.endpoint_id === endpointId);
  }

  function monitorLabel(tag: string | null): string {
    if (!tag) return "nothing";
    return monitors.find((m) => m.tag === tag)?.name ?? tag;
  }

  function lastSeenText(seconds: number | null): string {
    if (!seconds) return "never";
    const ago = Math.floor(Date.now() / 1000) - seconds;
    if (ago < 60) return "just now";
    if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
    if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
    return `${Math.floor(ago / 86400)}d ago`;
  }

  /** The URL an operator pastes into their alerting. Shown once, with the token. */
  function webhookUrl(token: string): string {
    return `${origin}/ext/alerts/${token}`;
  }

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
      const result = await call("getInboundFleet", {});
      endpoints = result.endpoints ?? [];
      alerts = result.alerts ?? [];
      monitors = result.monitors ?? [];
      providers = result.providers ?? [];
      templatedProviders = result.templated_providers ?? [];
      impacts = result.impacts ?? [];
      severities = result.severities ?? [];
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load inbound endpoints";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    origin = window.location.origin;
    load();
  });

  function openCreate() {
    createName = "";
    createProvider = providers[0] ?? "ALERTMANAGER";
    createMonitor = monitors.length > 0 ? monitors[0].tag : "";
    createDialog = { mode: "form" };
  }

  async function confirmCreate() {
    busy = true;
    try {
      const result = await call("createInboundEndpoint", {
        name: createName.trim(),
        provider: createProvider,
        default_monitor_tag: createMonitor || null
      });
      createDialog = { mode: "token", token: result.token, forName: createName.trim() };
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create that endpoint");
    } finally {
      busy = false;
    }
  }

  function openEdit(endpoint: Endpoint) {
    editing = endpoint;
    editName = endpoint.name;
    editMonitor = endpoint.default_monitor_tag ?? "";
    editImpact = endpoint.default_impact ?? "";
    editSeverity = endpoint.default_severity ?? "";
    editAutoResolve = endpoint.auto_resolve;
    // A copy, so cancelling an edit means reloading nothing.
    editRules = endpoint.mapping_rules.map((rule) => ({ ...rule }));
  }

  /**
   * Adds an empty rule row.
   *
   * Called from a click handler and never from the template. Mutating `$state`
   * inside a tracked computation throws `state_unsafe_mutation`, the render
   * dies, and the dialog sits on its spinner with the error only visible in the
   * browser console.
   */
  function addRule() {
    editRules = [...editRules, { label: "", equals: "", monitor_tag: monitors[0]?.tag ?? "" }];
  }

  function removeRule(index: number) {
    editRules = editRules.filter((_, i) => i !== index);
  }

  async function confirmEdit() {
    if (!editing) return;
    busy = true;
    try {
      await call("updateInboundEndpoint", {
        id: editing.id,
        name: editName.trim(),
        default_monitor_tag: editMonitor || null,
        default_impact: editImpact || null,
        default_severity: editSeverity || null,
        auto_resolve: editAutoResolve,
        mapping_rules: editRules
      });
      toast.success(`${editName.trim()} saved`);
      editing = null;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save that endpoint");
    } finally {
      busy = false;
    }
  }

  async function toggleStatus(endpoint: Endpoint) {
    busy = true;
    try {
      await call("updateInboundEndpoint", {
        id: endpoint.id,
        status: endpoint.status === "ACTIVE" ? "DISABLED" : "ACTIVE"
      });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change that endpoint");
    } finally {
      busy = false;
    }
  }

  async function rotateToken(endpoint: Endpoint) {
    busy = true;
    try {
      const result = await call("rotateInboundToken", { id: endpoint.id });
      createDialog = { mode: "token", token: result.token, forName: endpoint.name };
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rotate that token");
    } finally {
      busy = false;
    }
  }

  async function confirmDelete() {
    if (!confirmingDelete) return;
    busy = true;
    try {
      await call("deleteInboundEndpoint", { id: confirmingDelete.id });
      toast.success(`${confirmingDelete.name} deleted`);
      confirmingDelete = null;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete that endpoint");
    } finally {
      busy = false;
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy, select it by hand");
    }
  }
</script>

<div class="mx-auto flex max-w-5xl flex-col gap-6 p-4">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h1 class="text-2xl font-bold">Inbound Alerts</h1>
      <p class="text-muted-foreground max-w-2xl text-sm">
        Let alerting you already run open incidents here. Each endpoint has its own URL and token; whatever posts to it
        is mapped to a component and becomes an incident. Repeated notifications about one alert update that incident
        rather than opening another, and a resolved notification closes it.
      </p>
    </div>
    <Button disabled={busy} onclick={openCreate}>
      <PlusIcon class="size-4" /> New endpoint
    </Button>
  </div>

  {#if loading}
    <div class="flex justify-center p-8"><Spinner /></div>
  {:else if error}
    <p class="text-destructive text-sm">{error}</p>
  {:else}
    {#if endpoints.length === 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>Nothing is sending alerts yet</Card.Title>
          <Card.Description>
            Create an endpoint, then paste its URL into Alertmanager, Grafana, Sentry, CloudWatch or Uptime Kuma.
            {#if templatedProviders.length > 0}
              {templatedProviders.join(", ")} compose their own payloads, so they use the Generic provider and a
              template.
            {/if}
          </Card.Description>
        </Card.Header>
      </Card.Root>
    {/if}

    {#each endpoints as endpoint (endpoint.id)}
      {@const received = alertsFor(endpoint.id)}
      <Card.Root>
        <Card.Header>
          <Card.Title class="flex flex-wrap items-center gap-2">
            {endpoint.name}
            <Badge variant="outline">{endpoint.provider}</Badge>
            {#if endpoint.status !== "ACTIVE"}
              <Badge variant="outline">Disabled</Badge>
            {/if}
            {#if !endpoint.last_request_at}
              <Badge variant="destructive">never called</Badge>
            {/if}
          </Card.Title>
          <Card.Description>
            <span class="flex flex-wrap gap-x-3 text-xs">
              <span>token &hellip;{endpoint.token_hint ?? "????"}</span>
              <span>last called {lastSeenText(endpoint.last_request_at)}</span>
              <span>unmatched alerts go to {monitorLabel(endpoint.default_monitor_tag)}</span>
              <span>{endpoint.auto_resolve ? "closes incidents on resolve" : "never closes incidents"}</span>
            </span>
          </Card.Description>
        </Card.Header>
        <Card.Content class="flex flex-col gap-3">
          {#if endpoint.last_error}
            <p class="text-muted-foreground text-xs">Last problem: {endpoint.last_error}</p>
          {/if}

          {#if endpoint.mapping_rules.length > 0}
            <div class="flex flex-col gap-1">
              <span class="text-sm font-medium">Mapping, first match wins</span>
              {#each endpoint.mapping_rules as rule, i (i)}
                <p class="text-muted-foreground text-xs">
                  {rule.label} = {rule.equals} &rarr; {monitorLabel(rule.monitor_tag)}
                </p>
              {/each}
            </div>
          {/if}

          <div class="flex flex-col gap-1">
            <span class="text-sm font-medium">Recent alerts</span>
            {#if received.length === 0}
              <p class="text-muted-foreground text-xs">Nothing has arrived on this endpoint yet.</p>
            {:else}
              {#each received as alert (alert.id)}
                <div class="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-xs">
                  <span class="min-w-0 flex-1 truncate">
                    {alert.title ?? alert.fingerprint}
                  </span>
                  <span class="flex shrink-0 flex-wrap items-center gap-2">
                    <Badge variant={alert.status === "FIRING" ? "destructive" : "secondary"}>
                      {alert.status.toLowerCase()}
                    </Badge>
                    {#if alert.monitor_tag}
                      <span>{monitorLabel(alert.monitor_tag)}</span>
                    {:else}
                      <Badge variant="outline">no component</Badge>
                    {/if}
                    {#if alert.incident_id}
                      <span>incident #{alert.incident_id}</span>
                    {/if}
                    <span>{alert.notification_count}&times;</span>
                    <span>{lastSeenText(alert.last_seen_at)}</span>
                  </span>
                </div>
              {/each}
            {/if}
          </div>

          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy} onclick={() => toggleStatus(endpoint)}>
              {endpoint.status === "ACTIVE" ? "Disable" : "Enable"}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onclick={() => rotateToken(endpoint)} title="New token">
              <KeyRoundIcon class="size-4" />
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onclick={() => openEdit(endpoint)}>
              <PencilIcon class="size-4" />
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onclick={() => (confirmingDelete = endpoint)}>
              <TrashIcon class="size-4" />
            </Button>
          </div>
        </Card.Content>
      </Card.Root>
    {/each}
  {/if}
</div>

<Dialog.Root open={createDialog !== null} onOpenChange={(open) => (createDialog = open ? createDialog : null)}>
  <Dialog.Content>
    {#if createDialog && createDialog.mode === "token"}
      {@const tokenUrl = webhookUrl(createDialog.token)}
      <Dialog.Header>
        <Dialog.Title>{createDialog.forName} is ready</Dialog.Title>
        <Dialog.Description>
          Paste this URL into your alerting. It is shown once and cannot be recovered; if it is lost, issue a new one
          with the key button.
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex items-center gap-2">
        <Input readonly value={tokenUrl} />
        <Button variant="outline" size="sm" onclick={() => copy(tokenUrl)}>
          <CopyIcon class="size-4" />
        </Button>
      </div>
      <Dialog.Footer>
        <Button onclick={() => (createDialog = null)}>Done</Button>
      </Dialog.Footer>
    {:else}
      <Dialog.Header>
        <Dialog.Title>New inbound endpoint</Dialog.Title>
        <Dialog.Description>
          The provider decides how a payload is read, and cannot be changed afterwards.
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-2">
          <Label for="inbound-name">Name</Label>
          <Input id="inbound-name" bind:value={createName} placeholder="Alertmanager" />
        </div>
        <div class="flex flex-col gap-2">
          <Label for="inbound-provider">Provider</Label>
          <Select.Root type="single" value={createProvider} onValueChange={(v) => (createProvider = v ?? "")}>
            <Select.Trigger id="inbound-provider" class="w-full">{createProvider}</Select.Trigger>
            <Select.Content>
              {#each providers as provider (provider)}
                <Select.Item value={provider}>{provider}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          {#if createProvider === "GENERIC" && templatedProviders.length > 0}
            <p class="text-muted-foreground text-xs">
              Use this for {templatedProviders.join(", ")}, which each compose their own payload from a template you
              write. Send an object with a title, a status and an id.
            </p>
          {/if}
        </div>
        <div class="flex flex-col gap-2">
          <Label for="inbound-monitor">Component for anything unmatched</Label>
          <Select.Root type="single" value={createMonitor} onValueChange={(v) => (createMonitor = v ?? "")}>
            <Select.Trigger id="inbound-monitor" class="w-full">
              {createMonitor ? monitorLabel(createMonitor) : "Nothing, just record it"}
            </Select.Trigger>
            <Select.Content>
              {#each monitors as monitor (monitor.tag)}
                <Select.Item value={monitor.tag}>{monitor.name}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      </div>
      <Dialog.Footer>
        <Button variant="outline" disabled={busy} onclick={() => (createDialog = null)}>Cancel</Button>
        <Button disabled={busy || !canCreate} onclick={confirmCreate}>Create</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={editing !== null} onOpenChange={(open) => (editing = open ? editing : null)}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Edit {editing?.name}</Dialog.Title>
      <Dialog.Description>
        A rule sends an alert to a component when one of its labels matches. The first rule that matches wins, so order
        them from most specific to least.
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <Label for="inbound-edit-name">Name</Label>
        <Input id="inbound-edit-name" bind:value={editName} />
      </div>

      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium">Mapping rules</span>
        {#each editRules as rule, index (index)}
          <div class="flex flex-wrap items-center gap-2">
            <Input class="w-28" placeholder="label" bind:value={rule.label} />
            <Input class="w-28" placeholder="equals" bind:value={rule.equals} />
            <Select.Root type="single" value={rule.monitor_tag} onValueChange={(v) => (rule.monitor_tag = v ?? "")}>
              <Select.Trigger class="w-40">{monitorLabel(rule.monitor_tag)}</Select.Trigger>
              <Select.Content>
                {#each monitors as monitor (monitor.tag)}
                  <Select.Item value={monitor.tag}>{monitor.name}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <Button variant="outline" size="sm" onclick={() => removeRule(index)}>
              <TrashIcon class="size-4" />
            </Button>
          </div>
        {/each}
        <Button variant="outline" size="sm" class="self-start" onclick={addRule}>
          <PlusIcon class="size-4" /> Add a rule
        </Button>
      </div>

      <div class="flex flex-col gap-2">
        <Label for="inbound-edit-monitor">Component for anything unmatched</Label>
        <Select.Root type="single" value={editMonitor} onValueChange={(v) => (editMonitor = v ?? "")}>
          <Select.Trigger id="inbound-edit-monitor" class="w-full">
            {editMonitor ? monitorLabel(editMonitor) : "Nothing, just record it"}
          </Select.Trigger>
          <Select.Content>
            {#each monitors as monitor (monitor.tag)}
              <Select.Item value={monitor.tag}>{monitor.name}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>

      <div class="flex flex-col gap-2">
        <Label for="inbound-edit-impact">What the public page shows</Label>
        <Select.Root type="single" value={editImpact} onValueChange={(v) => (editImpact = v ?? "")}>
          <Select.Trigger id="inbound-edit-impact" class="w-full">{editImpact || "Partial outage (default)"}</Select.Trigger>
          <Select.Content>
            {#each impacts as impact (impact)}
              <Select.Item value={impact}>{impact}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>

      <div class="flex flex-col gap-2">
        <Label for="inbound-edit-severity">Severity when the sender does not say</Label>
        <Select.Root type="single" value={editSeverity} onValueChange={(v) => (editSeverity = v ?? "")}>
          <Select.Trigger id="inbound-edit-severity" class="w-full">{editSeverity || "Minor (default)"}</Select.Trigger>
          <Select.Content>
            {#each severities as severity (severity)}
              <Select.Item value={severity}>{severity}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>

      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" bind:checked={editAutoResolve} />
        Close the incident when the sender says the alert cleared
      </label>
    </div>
    <Dialog.Footer>
      <Button variant="outline" disabled={busy} onclick={() => (editing = null)}>Cancel</Button>
      <Button disabled={busy || editName.trim().length === 0} onclick={confirmEdit}>Save</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  open={confirmingDelete !== null}
  onOpenChange={(open) => (confirmingDelete = open ? confirmingDelete : null)}
>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Delete {confirmingDelete?.name}?</Dialog.Title>
      <Dialog.Description>
        Its token stops working at once and its alert history goes with it. The incidents it opened are part of the
        public record and are kept.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" disabled={busy} onclick={() => (confirmingDelete = null)}>Cancel</Button>
      <Button variant="destructive" disabled={busy} onclick={confirmDelete}>Delete</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
