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
    /** B1g. This agent's say among the others in its region. */
    weight: number;
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
    /** RULE if the region's rule put it here, OVERRIDE if somebody named it. */
    source: string;
    // An assignment belongs to the region and names no agent, which is B1e's
    // point: a region whose agents have all been deleted still has its monitors
    // and the screen can say nothing is serving it. Which agents serve a region
    // is read from `agents`, because there may be several.
    region_id: number;
  }
  interface RegionRule {
    region_id: number;
    rule: string;
    mode: string;
  }
  interface RegionOverride {
    monitor_tag: string;
    region_id: number;
    decision: string;
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
  let regionRules = $state<RegionRule[]>([]);
  let regionOverrides = $state<RegionOverride[]>([]);
  let monitors = $state<PickableMonitor[]>([]);

  // ---- B1d. The merge cascade ------------------------------------------
  interface MergeRegion {
    id: number;
    code: string;
    name: string;
    is_active: boolean;
    default_weight: number | null;
    default_trust_rank: number | null;
    default_mode: string | null;
    configurable: boolean;
  }
  interface MergeDefaults {
    policy: string;
    quorumThreshold: number;
    degradedOnDisagreement: boolean;
    defaultWeight: number;
    defaultTrustRank: number;
    defaultMode: string;
    localWeight: number;
    localTrustRank: number;
    localMode: string;
  }
  interface EffectiveSource {
    region_id: number;
    region_name: string;
    weight: number;
    trust_rank: number;
    mode: string;
  }

  let mergePolicies = $state<string[]>([]);
  let sourceModes = $state<string[]>([]);
  let localRegionId = $state(-1);
  let mergeRegions = $state<MergeRegion[]>([]);
  /** The saved instance defaults, and the copy the form is editing. */
  let mergeSaved = $state<MergeDefaults | null>(null);
  let mergeForm = $state<MergeDefaults | null>(null);

  /**
   * Whether the policy form differs from what is stored.
   *
   * Compared by value rather than tracked with a dirty flag, so that editing a
   * field and putting it back does not leave the screen claiming unsaved work.
   */
  let mergeDirty = $derived(
    mergeSaved !== null && mergeForm !== null && JSON.stringify(mergeSaved) !== JSON.stringify(mergeForm)
  );

  /** Which of the three policies' extra fields are worth showing at all. */
  let showsQuorum = $derived(mergeForm?.policy === "QUORUM_DOWN");
  let showsWeights = $derived(mergeForm?.policy === "WEIGHTED_MAJORITY");
  let showsTrust = $derived(mergeForm?.policy === "TRUST_ORDER");

  /** The per-monitor override dialog. */
  let policyMonitor = $state<string | null>(null);
  let policyLoading = $state(false);
  let policyOverride = $state<{
    policy: string | null;
    quorum_threshold: number | null;
    degraded_on_disagreement: boolean | null;
    sources: Array<{ region_id: number; weight: number | null; trust_rank: number | null; mode: string | null }>;
  } | null>(null);
  let policyEffective = $state<EffectiveSource[]>([]);
  let policyEffectivePolicy = $state<string>("");

  const POLICY_LABELS: Record<string, string> = {
    TRUST_ORDER: "Trust order",
    WEIGHTED_MAJORITY: "Weighted majority",
    QUORUM_DOWN: "Quorum before down"
  };
  const MODE_LABELS: Record<string, string> = {
    VOTE: "Counts",
    DISPLAY_ONLY: "Shown only",
    OFF: "Off"
  };

  function policyLabel(id: string): string {
    return POLICY_LABELS[id] ?? id;
  }
  function modeLabel(id: string): string {
    return MODE_LABELS[id] ?? id;
  }

  /**
   * The override row for one source in the open dialog.
   *
   * **A lookup, and nothing else.** This used to create the row when it was
   * missing, and it is called from the template, where every expression runs
   * inside a tracked computation. Pushing onto a `$state` array from there
   * throws `state_unsafe_mutation`, the render dies, and the dialog sits on its
   * spinner for ever with the error only visible in the browser console. The
   * rows are created once, in `openMonitorPolicy`, where mutation is allowed.
   */
  function overrideFor(regionId: number) {
    return policyOverride?.sources.find((s) => s.region_id === regionId) ?? null;
  }

  /**
   * Every source the dialog will draw has a row to bind to, all nulls.
   *
   * An all-null row is still "inherited" to every reader: `setMonitorSourcePolicy`
   * stores nulls and the cascade treats null as inherit, so creating them up
   * front changes no behaviour. It only stops the template needing to.
   */
  function ensureOverrideRows(sources: EffectiveSource[]) {
    if (!policyOverride) return;
    for (const source of sources) {
      if (policyOverride.sources.some((s) => s.region_id === source.region_id)) continue;
      policyOverride.sources.push({ region_id: source.region_id, weight: null, trust_rank: null, mode: null });
    }
  }

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
  let createWeight = $state("1");
  let createRegion = $state<string>("");
  let createRegionCode = $state("");
  let createRegionName = $state("");

  let editing = $state<Agent | null>(null);
  let editName = $state("");
  let editWeight = $state("1");
  let editRegion = $state<string>("");

  let editingRegion = $state<Region | null>(null);
  let editRegionName = $state("");
  let editRegionCode = $state("");

  /**
   * The built-in regions, which are named by what they mean rather than by an
   * operator: `merged` (0) is the computed verdict and `local` (-1) is the
   * server's own check. The action refuses to rename either, and hiding the
   * button is the same rule where somebody can see it before clicking.
   */
  function isReservedRegion(id: number): boolean {
    return id === mergedRegionId || id === localRegionId;
  }

  let assigning = $state<Region | null>(null);
  let assignTag = $state<string>("");

  let confirmingDelete = $state<Agent | null>(null);

  /**
   * Every region the create form may offer, which is now all of them.
   *
   * It used to be only regions with no agent, because a second agent in a region
   * would have been refused at connect time. A region may now be served by any
   * number of agents, which are replicas reduced to one verdict before the merge,
   * so there is nothing to filter out.
   */
  let selectableRegions = $derived(regions);

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

  function assignmentsFor(regionId: number): Assignment[] {
    return assignments.filter((assignment) => assignment.region_id === regionId);
  }

  /** The agents serving a region, in the order the fleet lists them. */
  function agentsFor(regionId: number): Agent[] {
    return agents.filter((agent) => agent.region_id === regionId);
  }

  /** A region with no rule row checks nothing, which is what the resolver believes too. */
  function ruleFor(regionId: number): string {
    return regionRules.find((rule) => rule.region_id === regionId)?.rule ?? "NONE";
  }

  /** Monitors this region does not already check, so the picker never offers a duplicate. */
  function assignableFor(regionId: number): PickableMonitor[] {
    const taken = new Set(assignmentsFor(regionId).map((assignment) => assignment.monitor_tag));
    return monitors.filter((monitor) => !taken.has(monitor.tag));
  }

  /**
   * Why a monitor is on a region's list, in the words an operator needs.
   *
   * The distinction is not cosmetic: removing a monitor the rule put there has
   * to store an exception, or the next reconcile puts it straight back.
   */
  function sourceLabel(assignment: Assignment): string {
    return assignment.source === "RULE" ? "by rule" : "added";
  }

  /** Monitors an exception is keeping off a region that would otherwise check them. */
  function excludedFor(regionId: number): string[] {
    return regionOverrides
      .filter((o) => o.region_id === regionId && o.decision === "EXCLUDE")
      .map((o) => o.monitor_tag)
      .filter((tag) => monitors.some((monitor) => monitor.tag === tag));
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
      regionRules = result.region_rules ?? [];
      regionOverrides = result.region_overrides ?? [];
      monitors = result.monitors ?? [];
      mergePolicies = result.merge_policies ?? [];
      sourceModes = result.source_modes ?? [];
      localRegionId = result.local_region_id ?? -1;
      mergeRegions = result.merge_regions ?? [];
      mergeSaved = result.merge_policy ?? null;
      // A separate copy, so cancelling an edit means reloading nothing.
      mergeForm = result.merge_policy ? { ...result.merge_policy } : null;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load probe agents";
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function saveMergePolicy() {
    if (!mergeForm) return;
    busy = true;
    try {
      const result = await call("setMergePolicy", { ...mergeForm });
      mergeSaved = { ...result.settings };
      mergeForm = { ...result.settings };
      toast.success("Merge policy saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the merge policy");
    } finally {
      busy = false;
    }
  }

  function resetMergePolicy() {
    if (mergeSaved) mergeForm = { ...mergeSaved };
  }

  /**
   * Saves one region's defaults.
   *
   * An empty field is sent as null, not as 0: null means "inherit the instance
   * default" and 0 is a real weight meaning "this region cannot carry a vote".
   */
  async function saveRegionDefaults(region: MergeRegion) {
    busy = true;
    try {
      await call("setRegionDefaults", {
        region_id: region.id,
        default_weight: region.default_weight,
        default_trust_rank: region.default_trust_rank,
        default_mode: region.default_mode
      });
      toast.success(`${region.name} saved`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the region");
      await load();
    } finally {
      busy = false;
    }
  }

  async function openMonitorPolicy(monitorTag: string) {
    policyMonitor = monitorTag;
    policyLoading = true;
    policyOverride = null;
    policyEffective = [];
    try {
      const result = await call("getMonitorMergePolicy", { monitor_tag: monitorTag });
      policyOverride = result.override;
      policyEffective = result.effective.sources ?? [];
      policyEffectivePolicy = result.effective.policy;
      ensureOverrideRows(policyEffective);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the monitor policy");
      policyMonitor = null;
    } finally {
      policyLoading = false;
    }
  }

  async function saveMonitorPolicy() {
    if (!policyMonitor || !policyOverride) return;
    busy = true;
    try {
      await call("setMonitorMergePolicy", { monitor_tag: policyMonitor, ...policyOverride });
      toast.success("Monitor policy saved");
      policyMonitor = null;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the monitor policy");
    } finally {
      busy = false;
    }
  }

  function openCreate() {
    createName = "";
    createWeight = "1";
    // The first existing region, so adding a second agent to a region somebody
    // already made is the default rather than something to go looking for.
    createRegion = selectableRegions.length > 0 ? String(selectableRegions[0].id) : NEW_REGION;
    createRegionCode = "";
    createRegionName = "";
    agentDialog = { mode: "form" };
  }

  async function confirmCreate() {
    busy = true;
    try {
      const result = await call("createProbeAgent", {
        name: createName.trim(),
        weight: Number(createWeight),
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

  function openRegionEdit(region: Region) {
    editingRegion = region;
    editRegionName = region.name;
    editRegionCode = region.code;
  }

  async function confirmRegionEdit() {
    if (!editingRegion) return;
    busy = true;
    try {
      await call("renameRegion", {
        region_id: editingRegion.id,
        name: editRegionName.trim(),
        code: editRegionCode.trim()
      });
      toast.success(`${editRegionName.trim()} renamed`);
      editingRegion = null;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rename that region");
    } finally {
      busy = false;
    }
  }

  function openEdit(agent: Agent) {
    editing = agent;
    editName = agent.name;
    editWeight = String(agent.weight ?? 1);
    editRegion = String(agent.region_id);
  }

  async function confirmEdit() {
    if (!editing) return;
    busy = true;
    try {
      await call("updateProbeAgent", {
        id: editing.id,
        name: editName.trim(),
        weight: Number(editWeight),
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

  function openAssign(region: Region) {
    assigning = region;
    const options = assignableFor(region.id);
    assignTag = options.length > 0 ? options[0].tag : "";
  }

  async function confirmAssign() {
    if (!assigning || !assignTag) return;
    busy = true;
    try {
      await call("setMonitorRegionAssignment", {
        monitor_tag: assignTag,
        region_id: assigning.id,
        decision: "INCLUDE"
      });
      toast.success(`${assignTag} is checked from ${assigning.name}`);
      assigning = null;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not assign that monitor");
    } finally {
      busy = false;
    }
  }

  /**
   * Takes a monitor off a region's list.
   *
   * The decision depends on the rule, and getting it wrong is the obvious bug:
   * on a region that checks everything, dropping the exception would let the
   * next reconcile put the monitor straight back, so the removal has to be
   * stored as an EXCLUDE. On a region that checks only what it was given, the
   * exception IS the assignment and removing it is the whole job.
   */
  async function unassign(assignment: Assignment) {
    const decision = ruleFor(assignment.region_id) === "ALL" ? "EXCLUDE" : "DEFAULT";
    busy = true;
    try {
      await call("setMonitorRegionAssignment", {
        monitor_tag: assignment.monitor_tag,
        region_id: assignment.region_id,
        decision
      });
      toast.success(`${assignment.monitor_tag} is no longer checked from ${regionLabel(assignment.region_id)}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove that assignment");
    } finally {
      busy = false;
    }
  }

  /** Puts an excluded monitor back under the region's rule. */
  async function clearException(regionId: number, tag: string) {
    busy = true;
    try {
      await call("setMonitorRegionAssignment", { monitor_tag: tag, region_id: regionId, decision: "DEFAULT" });
      toast.success(`${tag} follows the rule again`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not clear that exception");
    } finally {
      busy = false;
    }
  }

  async function setRule(regionId: number, rule: string) {
    busy = true;
    try {
      const result = await call("setProbeRegionRule", { region_id: regionId, rule });
      const moved = Number(result.created ?? 0) + Number(result.removed ?? 0);
      toast.success(
        rule === "ALL"
          ? `${regionLabel(regionId)} now checks every eligible monitor${moved ? ` (${moved} changed)` : ""}`
          : `${regionLabel(regionId)} now checks only what it is given${moved ? ` (${moved} changed)` : ""}`
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change that rule");
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

    {#if mergeForm}
      <Card.Root>
        <Card.Header>
          <Card.Title>How several answers become one status</Card.Title>
          <Card.Description>
            When a monitor is checked from more than one place, this decides what the page publishes. It applies to
            every monitor unless a region or a monitor below says otherwise.
          </Card.Description>
        </Card.Header>
        <Card.Content class="flex flex-col gap-4">
          <div class="flex flex-col gap-2">
            <Label for="merge-policy">Policy</Label>
            <Select.Root
              type="single"
              value={mergeForm.policy}
              onValueChange={(v) => mergeForm && (mergeForm.policy = v ?? mergeForm.policy)}
            >
              <Select.Trigger id="merge-policy" class="w-full">{policyLabel(mergeForm.policy)}</Select.Trigger>
              <Select.Content>
                {#each mergePolicies as policy (policy)}
                  <Select.Item value={policy}>{policyLabel(policy)}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <p class="text-muted-foreground text-xs">
              {#if showsTrust}
                The most trusted source that answered wins outright. Use this when one vantage point is simply right and
                the others are noise, such as a provider that blocks datacenter ranges and answers a residential probe
                normally.
              {:else if showsQuorum}
                A monitor is not called down until enough sources agree. Below the threshold the last published status
                is held, so one flaky vantage point cannot raise an alert on its own.
              {:else}
                Each source carries a weight and the heaviest status wins. An exact tie resolves to the worse status.
              {/if}
            </p>
          </div>

          {#if showsQuorum}
            <div class="flex flex-col gap-2">
              <Label for="merge-quorum">Sources that must agree before down</Label>
              <Input id="merge-quorum" type="number" min="1" bind:value={mergeForm.quorumThreshold} class="max-w-40" />
            </div>
          {/if}

          {#if showsWeights}
            <label class="flex items-start gap-2 text-sm">
              <input type="checkbox" class="mt-1" bind:checked={mergeForm.degradedOnDisagreement} />
              <span>
                Publish <strong>degraded</strong> when sources disagree.
                <span class="text-muted-foreground block text-xs">
                  Only ever downwards: a winning up with a dissenting source becomes degraded, and a winning down is
                  never softened. Has no effect under the other two policies, which resolve disagreement themselves.
                </span>
              </span>
            </label>
          {/if}

          <div class="grid gap-4 sm:grid-cols-2">
            <div class="flex flex-col gap-2 rounded-md border p-3">
              <p class="text-sm font-medium">The local check</p>
              <p class="text-muted-foreground text-xs">Kener checking from its own server.</p>
              <Label for="merge-local-mode" class="text-xs">Takes part</Label>
              <Select.Root
                type="single"
                value={mergeForm.localMode}
                onValueChange={(v) => mergeForm && (mergeForm.localMode = v ?? mergeForm.localMode)}
              >
                <Select.Trigger id="merge-local-mode" class="w-full">{modeLabel(mergeForm.localMode)}</Select.Trigger>
                <Select.Content>
                  {#each sourceModes as mode (mode)}
                    <Select.Item value={mode}>{modeLabel(mode)}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
              {#if mergeForm.localMode === "OFF"}
                <p class="text-xs text-amber-600">
                  Kener will not check these monitors itself at all. Only do this when every monitor is covered by a
                  probe, or nothing will be checked.
                </p>
              {/if}
              {#if showsWeights}
                <Label for="merge-local-weight" class="text-xs">Weight</Label>
                <Input id="merge-local-weight" type="number" min="0" bind:value={mergeForm.localWeight} />
              {/if}
              {#if showsTrust}
                <Label for="merge-local-trust" class="text-xs">Trust rank (lower wins)</Label>
                <Input id="merge-local-trust" type="number" min="0" bind:value={mergeForm.localTrustRank} />
              {/if}
            </div>

            <div class="flex flex-col gap-2 rounded-md border p-3">
              <p class="text-sm font-medium">Every probe region</p>
              <p class="text-muted-foreground text-xs">The starting point for a region that sets nothing of its own.</p>
              <Label for="merge-default-mode" class="text-xs">Takes part</Label>
              <Select.Root
                type="single"
                value={mergeForm.defaultMode}
                onValueChange={(v) => mergeForm && (mergeForm.defaultMode = v ?? mergeForm.defaultMode)}
              >
                <Select.Trigger id="merge-default-mode" class="w-full"
                  >{modeLabel(mergeForm.defaultMode)}</Select.Trigger
                >
                <Select.Content>
                  {#each sourceModes as mode (mode)}
                    <Select.Item value={mode}>{modeLabel(mode)}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
              {#if showsWeights}
                <Label for="merge-default-weight" class="text-xs">Weight</Label>
                <Input id="merge-default-weight" type="number" min="0" bind:value={mergeForm.defaultWeight} />
              {/if}
              {#if showsTrust}
                <Label for="merge-default-trust" class="text-xs">Trust rank (lower wins)</Label>
                <Input id="merge-default-trust" type="number" min="0" bind:value={mergeForm.defaultTrustRank} />
              {/if}
            </div>
          </div>

          {#if mergeRegions.some((r) => r.configurable && r.id !== localRegionId)}
            <div class="flex flex-col gap-2">
              <p class="text-sm font-medium">Per region</p>
              <p class="text-muted-foreground text-xs">
                Leave a field empty to inherit from above. A weight of 0 is not empty: it means the region is counted
                and carries no weight.
              </p>
              {#each mergeRegions.filter((r) => r.configurable && r.id !== localRegionId) as region (region.id)}
                <div class="flex flex-wrap items-end gap-2 rounded-md border p-2">
                  <div class="min-w-32 flex-1">
                    <p class="text-sm font-medium break-all">{region.name}</p>
                    <p class="text-muted-foreground text-xs break-all">{region.code}</p>
                  </div>
                  <div class="flex flex-col gap-1">
                    <Label for={`region-mode-${region.id}`} class="text-xs">Takes part</Label>
                    <Select.Root
                      type="single"
                      value={region.default_mode ?? ""}
                      onValueChange={(v) => (region.default_mode = v ? v : null)}
                    >
                      <Select.Trigger id={`region-mode-${region.id}`} class="w-36">
                        {region.default_mode ? modeLabel(region.default_mode) : "Inherited"}
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value="">Inherited</Select.Item>
                        {#each sourceModes as mode (mode)}
                          <Select.Item value={mode}>{modeLabel(mode)}</Select.Item>
                        {/each}
                      </Select.Content>
                    </Select.Root>
                  </div>
                  <div class="flex flex-col gap-1">
                    <Label for={`region-weight-${region.id}`} class="text-xs">Weight</Label>
                    <Input
                      id={`region-weight-${region.id}`}
                      type="number"
                      min="0"
                      class="w-24"
                      placeholder="inherit"
                      bind:value={region.default_weight}
                    />
                  </div>
                  <div class="flex flex-col gap-1">
                    <Label for={`region-trust-${region.id}`} class="text-xs">Trust</Label>
                    <Input
                      id={`region-trust-${region.id}`}
                      type="number"
                      min="0"
                      class="w-24"
                      placeholder="inherit"
                      bind:value={region.default_trust_rank}
                    />
                  </div>
                  <Button variant="outline" size="sm" disabled={busy} onclick={() => saveRegionDefaults(region)}>
                    Save
                  </Button>
                </div>
              {/each}
            </div>
          {/if}
        </Card.Content>
        <Card.Footer class="flex flex-wrap justify-end gap-2">
          {#if mergeDirty}
            <Button variant="ghost" disabled={busy} onclick={resetMergePolicy}>Discard</Button>
          {/if}
          <Button disabled={busy || !mergeDirty} onclick={saveMergePolicy}>Save policy</Button>
        </Card.Footer>
      </Card.Root>
    {/if}

    <!-- B1e. Coverage, region first and monitor second.
         A region is what an operator configures and what survives an agent being
         deleted and recreated, so it is what the list is keyed on. Every region
         appears, including ones with no agent: "Frankfurt covers nine monitors
         and nothing is serving it" is exactly the state that used to be
         invisible, because the assignments vanished with the agent. -->
    {#each regions as region (region.id)}
      {@const regionAgents = agentsFor(region.id)}
      {@const covered = assignmentsFor(region.id)}
      {@const excluded = excludedFor(region.id)}
      <Card.Root>
        <Card.Header>
          <Card.Title class="flex flex-wrap items-center gap-2">
            {regionLabel(region.id)}
            <Badge variant="outline">{covered.length} monitor{covered.length === 1 ? "" : "s"}</Badge>
            {#if regionAgents.length === 0}
              <Badge variant="destructive">no agent</Badge>
            {:else if regionAgents.length > 1}
              <Badge variant="secondary">{regionAgents.length} agents</Badge>
            {/if}
            {#if !isReservedRegion(region.id)}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onclick={() => openRegionEdit(region)}
                title="Rename this region"
              >
                <PencilIcon class="size-4" />
              </Button>
            {/if}
          </Card.Title>
          <Card.Description>
            {#if regionAgents.length === 0}
              Nothing is serving this region, so none of these monitors is being checked from it right now. The list is
              kept: create an agent here and it picks them straight back up.
            {:else if regionAgents.length > 1}
              {region.note} These {regionAgents.length} agents all answer for one vantage point: each runs every check, and
              their answers are reduced to the single verdict this region reports. Give one a higher weight to let it settle
              a disagreement; the region still casts one vote either way.
            {:else}
              {region.note}
            {/if}
          </Card.Description>
        </Card.Header>
        <Card.Content class="flex flex-col gap-3">
          {#each regionAgents as agent (agent.id)}
            <div class="flex flex-wrap items-start justify-between gap-3 rounded-md border p-2">
              <div class="min-w-0">
                <p class="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {agent.name}
                  {#if agent.weight !== 1}
                    <Badge variant="outline" title="Say among the other agents in this region">
                      {agent.weight === 0 ? "no vote" : `weight ${agent.weight}`}
                    </Badge>
                  {/if}
                  {#if agent.status !== "ACTIVE"}
                    <Badge variant="outline">Disabled</Badge>
                  {:else if agent.live === true}
                    <Badge variant="secondary">Connected</Badge>
                  {:else}
                    <Badge variant="outline">{agent.connection_state.toLowerCase()}</Badge>
                  {/if}
                </p>
                <p class="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                  <span>token &hellip;{agent.token_hint ?? "????"}</span>
                  <span>last seen {lastSeenText(agent.last_seen_at)}</span>
                  {#if agent.agent_version}<span>v{agent.agent_version}</span>{/if}
                  {#if agent.capabilities}<span>runs {agent.capabilities.join(", ")}</span>{/if}
                </p>
              </div>
              <div class="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" disabled={busy} onclick={() => toggleStatus(agent)}>
                  {agent.status === "ACTIVE" ? "Disable" : "Enable"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onclick={() => rotateToken(agent)}
                  title="New token"
                >
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
          {/each}

          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-medium">This region checks</span>
            <Button
              variant={ruleFor(region.id) === "ALL" ? "default" : "outline"}
              size="sm"
              disabled={busy || region.id === mergedRegionId}
              onclick={() => setRule(region.id, "ALL")}
            >
              Every eligible monitor
            </Button>
            <Button
              variant={ruleFor(region.id) === "NONE" ? "default" : "outline"}
              size="sm"
              disabled={busy}
              onclick={() => setRule(region.id, "NONE")}
            >
              Only what it is given
            </Button>
          </div>
          {#if region.id === mergedRegionId}
            <p class="text-muted-foreground text-xs">
              The merged verdict region cannot check everything at once: an agent here replaces Kener's own check, so
              each monitor has to be named deliberately.
            </p>
          {:else if ruleFor(region.id) === "ALL"}
            <p class="text-muted-foreground text-xs">
              Monitors created later are covered too, without anybody having to remember.
            </p>
          {/if}

          {#each covered as assignment (assignment.assignment_id)}
            <div class="flex items-center justify-between gap-3 rounded-md border p-2">
              <div class="flex min-w-0 items-center gap-2 truncate text-sm">
                <span class="font-medium">{assignment.monitor_tag}</span>
                <span class="text-muted-foreground text-xs">{sourceLabel(assignment)}</span>
                <!-- `assignment.mode` deliberately not shown. It is B1c's
                     REMOTE_PREFERRED column, which B1d stopped reading: how a
                     source takes part is now the resolved VOTE / DISPLAY_ONLY /
                     OFF from the cascade, set behind "Weighting". Printing the
                     dead column beside the live one invited an operator to
                     change the thing that no longer decides anything. -->
              </div>
              <div class="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onclick={() => openMonitorPolicy(assignment.monitor_tag)}
                >
                  Weighting
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onclick={() => unassign(assignment)}>Remove</Button>
              </div>
            </div>
          {:else}
            <p class="text-muted-foreground text-sm">Nothing is checked from here yet.</p>
          {/each}

          {#if excluded.length > 0}
            <div class="flex flex-col gap-2 rounded-md border border-dashed p-2">
              <p class="text-muted-foreground text-xs">
                Held back from this region's rule. Without these, the rule would cover them again on the next save.
              </p>
              {#each excluded as tag (tag)}
                <div class="flex items-center justify-between gap-3 text-sm">
                  <span class="min-w-0 truncate">{tag}</span>
                  <Button variant="ghost" size="sm" disabled={busy} onclick={() => clearException(region.id, tag)}>
                    Follow the rule
                  </Button>
                </div>
              {/each}
            </div>
          {/if}

          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || assignableFor(region.id).length === 0}
              onclick={() => openAssign(region)}
            >
              Add a monitor
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
          <Label for="probe-weight">Weight</Label>
          <Input id="probe-weight" type="number" min="0" step="1" bind:value={createWeight} placeholder="1" />
          <p class="text-muted-foreground text-xs">
            How much this agent counts against the others in its region. Leave it at 1 unless one of them should settle
            a disagreement. 0 records its result without giving it a vote. This never changes how much say the region
            has over other regions.
          </p>
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
              {#each selectableRegions as region (region.id)}
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
        <Label for="probe-edit-weight">Weight</Label>
        <Input id="probe-edit-weight" type="number" min="0" step="1" bind:value={editWeight} />
        <p class="text-muted-foreground text-xs">
          Its say against the other agents in this region. 0 records the result without giving it a vote. The region
          still casts exactly one vote whatever its agents weigh.
        </p>
      </div>
      <div class="flex flex-col gap-2">
        <Label for="probe-edit-region">Region</Label>
        <Select.Root type="single" value={editRegion} onValueChange={(v) => (editRegion = v ?? "")}>
          <Select.Trigger id="probe-edit-region" class="w-full">
            {editRegion ? regionLabel(Number(editRegion)) : "Pick a region"}
          </Select.Trigger>
          <Select.Content>
            {#each regions as region (region.id)}
              <Select.Item value={String(region.id)}>
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

<Dialog.Root open={editingRegion !== null} onOpenChange={(open) => (editingRegion = open ? editingRegion : null)}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Rename {editingRegion?.name}</Dialog.Title>
      <Dialog.Description>
        Renaming is safe: the region keeps its identity, so its agents, its monitor list and every sample already
        recorded from it stay exactly where they are. Only what this screen and the public breakdown call it changes.
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <Label for="region-edit-name">Name</Label>
        <Input id="region-edit-name" bind:value={editRegionName} />
      </div>
      <div class="flex flex-col gap-2">
        <Label for="region-edit-code">Slug</Label>
        <Input id="region-edit-code" bind:value={editRegionCode} />
        <p class="text-muted-foreground text-xs">
          Letters, numbers and hyphens; anything else becomes a hyphen. It has to be unique across the instance.
        </p>
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="outline" disabled={busy} onclick={() => (editingRegion = null)}>Cancel</Button>
      <Button
        disabled={busy || editRegionName.trim().length === 0 || editRegionCode.trim().length === 0}
        onclick={confirmRegionEdit}>Save</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={assigning !== null} onOpenChange={(open) => (assigning = open ? assigning : null)}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Check a monitor from {assigning?.name}</Dialog.Title>
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
        Its token stops working and the monitors its region covers are checked locally from the next tick, so nothing
        stops being monitored. The region keeps its coverage: create an agent there again and it picks the same monitors
        back up.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" disabled={busy} onclick={() => (confirmingDelete = null)}>Cancel</Button>
      <Button disabled={busy} onclick={confirmDelete}>Remove</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!--
  The per-monitor override.

  Long monitor tags are wrapped with `break-all` rather than truncated. A single
  `truncate` child inside `Dialog.Content`, which is a grid, sizes its track to
  the whole string and pushes the panel past its own max width - which in turn
  pushes the footer outside the panel and onto the overlay, where every click is
  swallowed. It renders almost correctly, which is what makes it expensive.
-->
<Dialog.Root open={policyMonitor !== null} onOpenChange={(open) => (policyMonitor = open ? policyMonitor : null)}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Weighting for this monitor</Dialog.Title>
      <Dialog.Description class="break-all">
        {policyMonitor}
      </Dialog.Description>
    </Dialog.Header>

    {#if policyLoading}
      <div class="flex justify-center p-6"><Spinner /></div>
    {:else if policyOverride}
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-2">
          <Label for="monitor-policy">Policy</Label>
          <Select.Root
            type="single"
            value={policyOverride.policy ?? ""}
            onValueChange={(v) => policyOverride && (policyOverride.policy = v ? v : null)}
          >
            <Select.Trigger id="monitor-policy" class="w-full">
              {policyOverride.policy
                ? policyLabel(policyOverride.policy)
                : `Inherited (${policyLabel(policyEffectivePolicy)})`}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="">Inherited ({policyLabel(policyEffectivePolicy)})</Select.Item>
              {#each mergePolicies as policy (policy)}
                <Select.Item value={policy}>{policyLabel(policy)}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>

        {#if (policyOverride.policy ?? policyEffectivePolicy) === "QUORUM_DOWN"}
          <div class="flex flex-col gap-2">
            <Label for="monitor-quorum">Sources that must agree before down</Label>
            <Input
              id="monitor-quorum"
              type="number"
              min="1"
              class="max-w-40"
              placeholder="inherit"
              bind:value={policyOverride.quorum_threshold}
            />
          </div>
        {/if}

        <div class="flex flex-col gap-2">
          <p class="text-sm font-medium">Sources</p>
          <p class="text-muted-foreground text-xs">
            Empty means inherited, and the inherited value is shown beside each field. To trust a probe over the local
            check, give it a <em>lower</em> trust rank than the local check has.
          </p>
          {#each policyEffective as source (source.region_id)}
            {@const row = overrideFor(source.region_id)}
            <div class="flex flex-wrap items-end gap-2 rounded-md border p-2">
              <div class="min-w-32 flex-1">
                <p class="text-sm font-medium break-all">{source.region_name}</p>
                <p class="text-muted-foreground text-xs">
                  now: {modeLabel(source.mode)}, weight {source.weight}, trust {source.trust_rank}
                </p>
              </div>
              {#if row}
                <div class="flex flex-col gap-1">
                  <Label for={`src-mode-${source.region_id}`} class="text-xs">Takes part</Label>
                  <Select.Root type="single" value={row.mode ?? ""} onValueChange={(v) => (row.mode = v ? v : null)}>
                    <Select.Trigger id={`src-mode-${source.region_id}`} class="w-32">
                      {row.mode ? modeLabel(row.mode) : "Inherited"}
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="">Inherited</Select.Item>
                      {#each sourceModes as mode (mode)}
                        <Select.Item value={mode}>{modeLabel(mode)}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </div>
                <div class="flex flex-col gap-1">
                  <Label for={`src-weight-${source.region_id}`} class="text-xs">Weight</Label>
                  <Input
                    id={`src-weight-${source.region_id}`}
                    type="number"
                    min="0"
                    class="w-20"
                    placeholder="inherit"
                    bind:value={row.weight}
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <Label for={`src-trust-${source.region_id}`} class="text-xs">Trust</Label>
                  <Input
                    id={`src-trust-${source.region_id}`}
                    type="number"
                    min="0"
                    class="w-20"
                    placeholder="inherit"
                    bind:value={row.trust_rank}
                  />
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <Dialog.Footer class="gap-2 sm:justify-end">
      <Button variant="outline" disabled={busy} onclick={() => (policyMonitor = null)}>Cancel</Button>
      <Button disabled={busy || policyLoading} onclick={saveMonitorPolicy}>Save</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
