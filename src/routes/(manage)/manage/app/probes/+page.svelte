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

  // B1c. Remote probe agents: small daemons elsewhere in the world that run a
  // check Kener asks them to run and report the result back.
  //
  // The one thing this screen has to make legible is what a *region* means,
  // because it is the whole difference between the two ways a probe can be used.
  // An agent at the merged region replaces the local check and produces the
  // authoritative status; an agent at any other region adds that region's sample
  // alongside a status Kener still computes itself. Everything else here -
  // tokens, assignments, connection state - is bookkeeping around that choice.

  interface Region {
    id: number;
    code: string;
    name: string;
    is_active: boolean;
    note: string;
  }
  interface Agent {
    id: number;
    name: string;
    region_id: number;
    status: string;
    connection_state: string;
    live: boolean | null;
    token_hint: string | null;
    agent_version: string | null;
    capabilities: string[] | null;
    last_seen_at: number | null;
  }
  interface Assignment {
    assignment_id: number;
    monitor_tag: string;
    mode: string;
    agent_id: number;
    agent_name: string;
    region_id: number;
    status: string;
    connection_state: string;
  }
  interface PickableMonitor {
    tag: string;
    name: string;
    monitor_type: string;
  }

  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);

  let wsEnabled = $state(false);
  let wsPort = $state<number | null>(null);
  let mergedRegionId = $state(0);
  let eligibleTypes = $state<string[]>([]);
  let regions = $state<Region[]>([]);
  let agents = $state<Agent[]>([]);
  let assignments = $state<Assignment[]>([]);
  let monitors = $state<PickableMonitor[]>([]);

  /** The sentinel the region picker uses for "make a new one". Not a region id. */
  const NEW_REGION = "__new__";

  /**
   * The agent dialog, in one of its two phases.
   *
   * **One dialog, not two, and that is a correctness decision rather than a
   * tidiness one.** Creating an agent and then revealing its token were two
   * `Dialog.Root`s at first. Closing one while opening the other leaves the
   * first mounted for its exit animation, and its overlay sits above the second:
   * the token, which is shown exactly once and can never be recovered, rendered
   * behind a dimmed layer that swallowed every click. Swapping the content of a
   * dialog that never closes makes that impossible to reintroduce.
   */
  type AgentDialog = { mode: "form" } | { mode: "token"; token: string; forName: string };

  let agentDialog = $state<AgentDialog | null>(null);
  let createName = $state("");
  let createRegion = $state<string>("");
  let createRegionCode = $state("");
  let createRegionName = $state("");

  let editing = $state<Agent | null>(null);
  let editName = $state("");
  let editRegion = $state<string>("");

  let assigning = $state<Agent | null>(null);
  let assignTag = $state<string>("");

  let confirmingDelete = $state<Agent | null>(null);

  /** Regions with no agent yet, which is the only thing the create form may offer. */
  let freeRegions = $derived(regions.filter((region) => !agents.some((agent) => agent.region_id === region.id)));

  /** What the open assign dialog may offer, or nothing when no dialog is open. */
  let assignOptions = $derived(assigning ? assignableFor(assigning.id) : []);

  /** A new region needs both of its own fields before the agent can be made. */
  let canCreate = $derived(
    createName.trim().length > 0 &&
      (createRegion === NEW_REGION
        ? createRegionCode.trim().length > 0 && createRegionName.trim().length > 0
        : createRegion.length > 0)
  );

  function regionLabel(id: number): string {
    const region = regions.find((r) => r.id === id);
    if (!region) return `Region ${id}`;
    return id === mergedRegionId ? region.name : `${region.name} (${region.code})`;
  }

  function assignmentsFor(agentId: number): Assignment[] {
    return assignments.filter((assignment) => assignment.agent_id === agentId);
  }

  /** Monitors this agent does not already have, so the picker never offers a duplicate. */
  function assignableFor(agentId: number): PickableMonitor[] {
    const taken = new Set(assignmentsFor(agentId).map((assignment) => assignment.monitor_tag));
    return monitors.filter((monitor) => !taken.has(monitor.tag));
  }

  function lastSeenText(seconds: number | null): string {
    if (!seconds) return "never";
    const ago = Math.floor(Date.now() / 1000) - seconds;
    if (ago < 60) return "just now";
    if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
    if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
    return `${Math.floor(ago / 86400)}d ago`;
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
      const result = await call("getProbeFleet", {});
      wsEnabled = result.ws_enabled;
      wsPort = result.ws_port;
      mergedRegionId = result.merged_region_id;
      eligibleTypes = result.eligible_types ?? [];
      regions = result.regions ?? [];
      agents = result.agents ?? [];
      assignments = result.assignments ?? [];
      monitors = result.monitors ?? [];
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load probe agents";
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function openCreate() {
    createName = "";
    // Default to making a new region when every existing one is taken, which is
    // the ordinary case: Kener seeds only the merged verdict, so the second
    // agent an operator creates always needs a region that does not exist yet.
    createRegion = freeRegions.length > 0 ? String(freeRegions[0].id) : NEW_REGION;
    createRegionCode = "";
    createRegionName = "";
    agentDialog = { mode: "form" };
  }

  async function confirmCreate() {
    busy = true;
    try {
      const result = await call("createProbeAgent", {
        name: createName.trim(),
        ...(createRegion === NEW_REGION
          ? { new_region: { code: createRegionCode.trim(), name: createRegionName.trim() } }
          : { region_id: Number(createRegion) })
      });
      // The same dialog, now showing the token. It never closes in between, so
      // there is no window in which two overlays exist at once.
      agentDialog = { mode: "token", token: result.token, forName: createName.trim() };
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create that agent");
    } finally {
      busy = false;
    }
  }

  function openEdit(agent: Agent) {
    editing = agent;
    editName = agent.name;
    editRegion = String(agent.region_id);
  }

  async function confirmEdit() {
    if (!editing) return;
    busy = true;
    try {
      await call("updateProbeAgent", {
        id: editing.id,
        name: editName.trim(),
        region_id: Number(editRegion)
      });
      toast.success(`${editName.trim()} updated`);
      editing = null;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update that agent");
    } finally {
      busy = false;
    }
  }

  async function toggleStatus(agent: Agent) {
    busy = true;
    const next = agent.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    try {
      await call("updateProbeAgent", { id: agent.id, status: next });
      toast.success(
        next === "DISABLED"
          ? `${agent.name} is switched off. Its monitors are checked locally from the next tick.`
          : `${agent.name} is active again`
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change that agent");
    } finally {
      busy = false;
    }
  }

  async function rotateToken(agent: Agent) {
    busy = true;
    try {
      const result = await call("rotateProbeAgentToken", { id: agent.id });
      agentDialog = { mode: "token", token: result.token, forName: agent.name };
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
    const name = confirmingDelete.name;
    try {
      await call("deleteProbeAgent", { id: confirmingDelete.id });
      toast.success(`${name} removed`);
      confirmingDelete = null;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove that agent");
    } finally {
      busy = false;
    }
  }

  function openAssign(agent: Agent) {
    assigning = agent;
    const options = assignableFor(agent.id);
    assignTag = options.length > 0 ? options[0].tag : "";
  }

  async function confirmAssign() {
    if (!assigning || !assignTag) return;
    busy = true;
    try {
      await call("assignMonitorToProbe", { monitor_tag: assignTag, agent_id: assigning.id });
      toast.success(`Assigned to ${assigning.name}`);
      assigning = null;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not assign that monitor");
    } finally {
      busy = false;
    }
  }

  async function unassign(assignment: Assignment) {
    busy = true;
    try {
      await call("unassignMonitorFromProbe", { id: assignment.assignment_id });
      toast.success(`${assignment.monitor_tag} is checked locally again`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove that assignment");
    } finally {
      busy = false;
    }
  }

  async function copyToken() {
    if (agentDialog?.mode !== "token") return;
    try {
      await navigator.clipboard.writeText(agentDialog.token);
      toast.success("Token copied");
    } catch {
      toast.error("Could not copy. Select the token and copy it by hand.");
    }
  }
</script>

<svelte:head><title>Probes</title></svelte:head>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">Probes</h1>
      <p class="text-muted-foreground text-sm">
        Remote agents that run checks from somewhere other than this server and report the results back. An agent in the
        <span class="font-medium">Merged verdict</span> region replaces the local check and produces the authoritative status;
        an agent in any other region adds that region&rsquo;s sample alongside a status Kener still computes here. Either
        way, a probe that goes quiet means the check runs locally again on the next tick.
      </p>
    </div>
    <Button class="shrink-0" disabled={busy} onclick={openCreate}>
      <PlusIcon class="size-4" />
      New agent
    </Button>
  </div>

  {#if loading}
    <div class="flex justify-center p-8"><Spinner /></div>
  {:else if error}
    <Card.Root><Card.Content class="p-6 text-red-600">{error}</Card.Content></Card.Root>
  {:else}
    {#if !wsEnabled}
      <Card.Root class="border-amber-500/50">
        <Card.Content class="p-4 text-sm">
          <span class="font-medium">No probe listener is running.</span>
          <span class="text-muted-foreground">
            Agents can be configured here, but none can connect until
            <code class="font-mono text-xs">KENER_PROBE_WS_PORT</code> is set on the process that runs the schedulers. Until
            then every monitor below is checked locally.
          </span>
        </Card.Content>
      </Card.Root>
    {/if}

    {#if agents.length === 0}
      <Card.Root>
        <Card.Content class="text-muted-foreground p-8 text-center text-sm">
          No probe agents yet. Create one to get a token, then run the probe daemon somewhere else with that token and
          this server&rsquo;s address.
        </Card.Content>
      </Card.Root>
    {/if}

    {#each agents as agent (agent.id)}
      <Card.Root>
        <Card.Header>
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <Card.Title class="flex flex-wrap items-center gap-2">
                {agent.name}
                {#if agent.region_id === mergedRegionId}
                  <Badge>Merged verdict</Badge>
                {:else}
                  <Badge variant="secondary">{regionLabel(agent.region_id)}</Badge>
                {/if}
                {#if agent.status !== "ACTIVE"}
                  <Badge variant="outline">Disabled</Badge>
                {:else if agent.live === true}
                  <Badge variant="secondary">Connected</Badge>
                {:else if agent.live === false}
                  <Badge variant="outline">{agent.connection_state.toLowerCase()}</Badge>
                {:else}
                  <Badge variant="outline">{agent.connection_state.toLowerCase()}</Badge>
                {/if}
              </Card.Title>
              <Card.Description class="flex flex-wrap gap-x-3">
                <span>token &hellip;{agent.token_hint ?? "????"}</span>
                <span>last seen {lastSeenText(agent.last_seen_at)}</span>
                {#if agent.agent_version}<span>v{agent.agent_version}</span>{/if}
                {#if agent.capabilities}<span>runs {agent.capabilities.join(", ")}</span>{/if}
              </Card.Description>
            </div>
            <div class="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" disabled={busy} onclick={() => toggleStatus(agent)}>
                {agent.status === "ACTIVE" ? "Disable" : "Enable"}
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onclick={() => rotateToken(agent)} title="New token">
                <KeyRoundIcon class="size-4" />
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onclick={() => openEdit(agent)}>
                <PencilIcon class="size-4" />
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onclick={() => (confirmingDelete = agent)}>
                <TrashIcon class="size-4" />
              </Button>
            </div>
          </div>
        </Card.Header>
        <Card.Content class="flex flex-col gap-2">
          {#each assignmentsFor(agent.id) as assignment (assignment.assignment_id)}
            <div class="flex items-center justify-between gap-3 rounded-md border p-2">
              <div class="min-w-0 truncate text-sm">
                <span class="font-medium">{assignment.monitor_tag}</span>
                <span class="text-muted-foreground text-xs">&middot; {assignment.mode.toLowerCase()}</span>
              </div>
              <Button variant="outline" size="sm" disabled={busy} onclick={() => unassign(assignment)}>Remove</Button>
            </div>
          {:else}
            <p class="text-muted-foreground text-sm">
              Nothing assigned. This agent will connect and sit idle until it is given a monitor.
            </p>
          {/each}
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || assignableFor(agent.id).length === 0}
              onclick={() => openAssign(agent)}
            >
              Assign a monitor
            </Button>
          </div>
        </Card.Content>
      </Card.Root>
    {/each}
  {/if}
</div>

<Dialog.Root open={agentDialog !== null} onOpenChange={(open) => (agentDialog = open ? agentDialog : null)}>
  <Dialog.Content>
    {#if agentDialog?.mode === "form"}
      <Dialog.Header>
        <Dialog.Title>New probe agent</Dialog.Title>
        <Dialog.Description>
          The token appears here once it is created, and cannot be recovered afterwards.
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-2">
          <Label for="probe-name">Name</Label>
          <Input id="probe-name" bind:value={createName} placeholder="Frankfurt" />
        </div>
        <div class="flex flex-col gap-2">
          <Label for="probe-region">Region</Label>
          <Select.Root type="single" value={createRegion} onValueChange={(v) => (createRegion = v ?? "")}>
            <Select.Trigger id="probe-region" class="w-full">
              {createRegion === NEW_REGION
                ? "A new region"
                : createRegion
                  ? regionLabel(Number(createRegion))
                  : "Pick a region"}
            </Select.Trigger>
            <Select.Content>
              {#each freeRegions as region (region.id)}
                <Select.Item value={String(region.id)}>{regionLabel(region.id)}</Select.Item>
              {/each}
              <Select.Item value={NEW_REGION}>A new region&hellip;</Select.Item>
            </Select.Content>
          </Select.Root>
          {#if createRegion && createRegion !== NEW_REGION}
            <p class="text-muted-foreground text-xs">
              {regions.find((r) => r.id === Number(createRegion))?.note}
            </p>
          {/if}
        </div>

        {#if createRegion === NEW_REGION}
          <div class="flex flex-col gap-2">
            <Label for="probe-region-name">Region name</Label>
            <Input id="probe-region-name" bind:value={createRegionName} placeholder="Frankfurt" />
            <Label for="probe-region-code">Region code</Label>
            <Input id="probe-region-code" bind:value={createRegionCode} placeholder="eu-central" />
            <p class="text-muted-foreground text-xs">
              The code identifies the region across the whole instance and cannot be reused. A new region always reports
              alongside the local check, never in place of it.
            </p>
          </div>
        {/if}
      </div>
      <Dialog.Footer>
        <Button variant="outline" disabled={busy} onclick={() => (agentDialog = null)}>Cancel</Button>
        <Button disabled={busy || !canCreate} onclick={confirmCreate}>Create</Button>
      </Dialog.Footer>
    {:else if agentDialog?.mode === "token"}
      <Dialog.Header>
        <Dialog.Title>Token for {agentDialog.forName}</Dialog.Title>
        <Dialog.Description>
          Copy this now. Kener stores only a hash of it, so this is the only time it can be shown. If it is lost, issue
          a new one with the key button.
        </Dialog.Description>
      </Dialog.Header>
      <!--
        The token wraps rather than truncating, and that is load-bearing twice
        over. It is the one string an operator must copy by hand if the clipboard
        is unavailable, so hiding half of it behind an ellipsis is the wrong
        default for the only time it is ever shown. And `truncate` sets
        `whitespace-nowrap`, whose min-content is the full 76 characters: the
        dialog is a grid, an `auto` track cannot shrink below its min-content, so
        the whole panel was forced ~100px wider than its own `max-w-lg` and the
        footer landed outside the dialog, on top of the overlay, unclickable.
      -->
      <div class="flex min-w-0 items-start gap-2">
        <code class="bg-muted min-w-0 flex-1 rounded-md p-2 font-mono text-xs break-all">{agentDialog.token}</code>
        <Button variant="outline" size="sm" onclick={copyToken}><CopyIcon class="size-4" /></Button>
      </div>
      <p class="text-muted-foreground text-xs">
        Give it to the probe as <code class="font-mono">KENER_PROBE_TOKEN</code>, along with
        <code class="font-mono">KENER_PROBE_URL</code> pointing at this server{wsPort ? ` on port ${wsPort}` : ""}.
      </p>
      <Dialog.Footer>
        <Button onclick={() => (agentDialog = null)}>Done</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={editing !== null} onOpenChange={(open) => (editing = open ? editing : null)}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Edit {editing?.name}</Dialog.Title>
      <Dialog.Description>
        Moving an agent between regions changes what its results mean, not where it runs.
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <Label for="probe-edit-name">Name</Label>
        <Input id="probe-edit-name" bind:value={editName} />
      </div>
      <div class="flex flex-col gap-2">
        <Label for="probe-edit-region">Region</Label>
        <Select.Root type="single" value={editRegion} onValueChange={(v) => (editRegion = v ?? "")}>
          <Select.Trigger id="probe-edit-region" class="w-full">
            {editRegion ? regionLabel(Number(editRegion)) : "Pick a region"}
          </Select.Trigger>
          <Select.Content>
            {#each regions as region (region.id)}
              <Select.Item
                value={String(region.id)}
                disabled={region.id !== editing?.region_id && agents.some((a) => a.region_id === region.id)}
              >
                {regionLabel(region.id)}
              </Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        {#if editRegion}
          <p class="text-muted-foreground text-xs">{regions.find((r) => r.id === Number(editRegion))?.note}</p>
        {/if}
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="outline" disabled={busy} onclick={() => (editing = null)}>Cancel</Button>
      <Button disabled={busy || editName.trim().length === 0} onclick={confirmEdit}>Save</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={assigning !== null} onOpenChange={(open) => (assigning = open ? assigning : null)}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Assign a monitor to {assigning?.name}</Dialog.Title>
      <Dialog.Description>
        Only {eligibleTypes.join(", ")} monitors can run on a probe. The rest need something only this server has: Redis,
        the database, or a connection Kener holds.
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-2">
      <Label for="probe-assign">Monitor</Label>
      <Select.Root type="single" value={assignTag} onValueChange={(v) => (assignTag = v ?? "")}>
        <Select.Trigger id="probe-assign" class="w-full">
          {assignTag || "Pick a monitor"}
        </Select.Trigger>
        <Select.Content>
          {#each assignOptions as monitor (monitor.tag)}
            <Select.Item value={monitor.tag}>{monitor.name} ({monitor.monitor_type})</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <Dialog.Footer>
      <Button variant="outline" disabled={busy} onclick={() => (assigning = null)}>Cancel</Button>
      <Button disabled={busy || !assignTag} onclick={confirmAssign}>Assign</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  open={confirmingDelete !== null}
  onOpenChange={(open) => (confirmingDelete = open ? confirmingDelete : null)}
>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Remove {confirmingDelete?.name}?</Dialog.Title>
      <Dialog.Description>
        Its token stops working and its assignments go with it. Every monitor it was checking is checked locally from
        the next tick, so nothing stops being monitored.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" disabled={busy} onclick={() => (confirmingDelete = null)}>Cancel</Button>
      <Button disabled={busy} onclick={confirmDelete}>Remove</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
