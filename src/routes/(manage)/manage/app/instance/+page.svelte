<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import CheckIcon from "@lucide/svelte/icons/check";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import { toast } from "svelte-sonner";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";

  // KENER-31. The instance console: the one screen that looks across tenants.
  //
  // Reachable only by the instance superadmin (`users.is_owner`), enforced in
  // `(manage)/+layout.server.ts` for the route and by `superadmin: true` on each
  // of the three actions. There is no permission that opens it, deliberately -
  // see instanceController.ts.
  //
  // **Read-mostly by design.** The only write here is suspend and reactivate.
  // The console can show that a tenant has a single owner and that they are
  // deactivated; it cannot reach inside and fix that, because a console able to
  // quietly grant itself membership of any org is one whose audit log means
  // nothing. Administering a tenant means being a member of it and switching in.

  interface OrgSummary {
    id: number;
    slug: string;
    name: string;
    status: string;
    is_default: boolean;
    tag_prefix: string;
    members: number;
    monitors: number;
    pages: number;
    domains: number;
  }

  interface OrgMember {
    user_id: number;
    email: string;
    name: string;
    is_active: boolean;
    is_owner: boolean;
    role_ids: string[];
  }

  interface OrgDetail extends OrgSummary {
    domain_list: Array<{ id: number; hostname: string; status: string }>;
    member_list: OrgMember[];
  }

  let orgs = $state<OrgSummary[]>([]);
  let loading = $state(true);
  let saving = $state(false);

  let detail = $state<OrgDetail | null>(null);
  let detailLoading = $state(false);
  let suspendTarget = $state<OrgSummary | null>(null);

  // An org with no owner cannot be administered by anybody in it, and an org
  // whose only owners are deactivated is in the same position without looking
  // it. Both are worth surfacing on the list rather than only in the drill-down,
  // because the reason to open this screen at all is usually that something is
  // wrong somewhere and you do not know where.
  const activeOrgs = $derived(orgs.filter((o) => o.status === "ACTIVE").length);
  const suspendedOrgs = $derived(orgs.filter((o) => o.status !== "ACTIVE").length);

  async function call(action: string, data: Record<string, unknown> = {}) {
    const response = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    const body = await response.json();
    if (!response.ok || body?.error) throw new Error(body?.error || "Request failed");
    return body;
  }

  async function load() {
    loading = true;
    try {
      const resp = await call("getInstanceOrgs");
      orgs = resp?.orgs ?? [];
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the organisations");
    } finally {
      loading = false;
    }
  }

  // ---- I3g. The instance `site_data` layer ------------------------------
  //
  // These are the defaults every organisation inherits. A tenant overriding one
  // stores a row of its own; the rest read straight through to here, so editing
  // a value on this screen reaches every org that has not changed it.
  interface DefaultKey {
    key: string;
    data_type: string;
    value: string | null;
    instance_scoped: boolean;
  }

  let defaults = $state<DefaultKey[]>([]);
  let defaultsLoading = $state(false);
  let defaultsOpen = $state(false);
  let editingKey = $state<DefaultKey | null>(null);
  let editingValue = $state("");
  let filter = $state("");

  /**
   * Instance-scoped keys first, then the rest alphabetically.
   *
   * The two halves do genuinely different things - one changes a setting
   * outright, the other changes a default a tenant may override - and the ones
   * that cannot be overridden are the ones worth finding first.
   */
  let visibleDefaults = $derived(
    defaults
      .filter((entry) => entry.key.toLowerCase().includes(filter.trim().toLowerCase()))
      .slice()
      .sort((a, b) => {
        if (a.instance_scoped !== b.instance_scoped) return a.instance_scoped ? -1 : 1;
        return a.key.localeCompare(b.key);
      })
  );

  async function loadDefaults() {
    defaultsLoading = true;
    try {
      const resp = await call("getInstanceDefaults");
      defaults = resp?.keys ?? [];
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the instance defaults");
    } finally {
      defaultsLoading = false;
    }
  }

  function openDefaults() {
    defaultsOpen = !defaultsOpen;
    if (defaultsOpen && defaults.length === 0) loadDefaults();
  }

  function editDefault(entry: DefaultKey) {
    editingKey = entry;
    editingValue = entry.value ?? "";
  }

  async function saveDefault() {
    if (!editingKey) return;
    saving = true;
    try {
      await call("setInstanceDefault", { key: editingKey.key, value: editingValue });
      toast.success(`${editingKey.key} saved`);
      editingKey = null;
      await loadDefaults();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save that value");
    } finally {
      saving = false;
    }
  }

  async function openDetail(org: OrgSummary) {
    detailLoading = true;
    detail = null;
    try {
      detail = await call("getInstanceOrgDetail", { org_id: org.id });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open that organisation");
    } finally {
      detailLoading = false;
    }
  }

  async function setStatus(org: OrgSummary, status: string) {
    suspendTarget = null;
    saving = true;
    try {
      await call("setInstanceOrgStatus", { org_id: org.id, status });
      toast.success(status === "ACTIVE" ? "Organisation reactivated" : "Organisation suspended");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change that organisation");
    } finally {
      saving = false;
    }
  }

  onMount(load);
</script>

<div class="flex w-full flex-col gap-4 p-4">
  <Card.Root>
    <Card.Header>
      <Card.Title>Instance</Card.Title>
      <Card.Description>
        Every organisation on this installation, including suspended ones. This screen is the only place a suspended
        organisation can be found and brought back, and the only place that looks across tenants at all. It is read-only
        apart from suspending: administering an organisation means switching into it.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      {#if loading}
        <div class="flex justify-center p-8"><Spinner /></div>
      {:else}
        <div class="text-muted-foreground mb-4 flex flex-wrap items-center gap-3 text-sm">
          <span>{orgs.length} {orgs.length === 1 ? "organisation" : "organisations"}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{activeOrgs} active</span>
          {#if suspendedOrgs > 0}
            <span aria-hidden="true">&middot;</span>
            <span>{suspendedOrgs} suspended</span>
          {/if}
        </div>

        <div class="overflow-x-auto">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Organisation</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head class="text-end">Members</Table.Head>
                <Table.Head class="text-end">Monitors</Table.Head>
                <Table.Head class="text-end">Pages</Table.Head>
                <Table.Head class="text-end">Hostnames</Table.Head>
                <Table.Head></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each orgs as org (org.id)}
                <Table.Row>
                  <Table.Cell>
                    <div class="flex flex-col">
                      <span class="font-medium">{org.name}</span>
                      <span class="text-muted-foreground text-xs"><code>{org.slug}</code></span>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <div class="flex flex-wrap items-center gap-1">
                      {#if org.status === "ACTIVE"}
                        <Badge variant="secondary">Active</Badge>
                      {:else}
                        <Badge variant="destructive">Suspended</Badge>
                      {/if}
                      {#if org.is_default}
                        <Badge variant="outline">Default</Badge>
                      {/if}
                    </div>
                  </Table.Cell>
                  <Table.Cell class="text-end tabular-nums">{org.members}</Table.Cell>
                  <Table.Cell class="text-end tabular-nums">{org.monitors}</Table.Cell>
                  <Table.Cell class="text-end tabular-nums">{org.pages}</Table.Cell>
                  <Table.Cell class="text-end tabular-nums">{org.domains}</Table.Cell>
                  <Table.Cell class="text-end">
                    <div class="flex flex-wrap justify-end gap-1">
                      <Button variant="ghost" size="sm" disabled={detailLoading} onclick={() => openDetail(org)}>
                        Inspect
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        href={clientResolver(resolve, `/o/${org.slug}/`)}
                        target="_blank"
                        rel="noopener"
                      >
                        <ExternalLinkIcon class="size-4" />
                        <span class="sr-only">Status page</span>
                      </Button>
                      {#if org.status === "ACTIVE"}
                        <!-- The default org owns everything predating tenancy and is
                             where a session with no org lands, so suspending it would
                             take the instance down and leave no screen to undo it. The
                             server refuses it too; this only spares the click. -->
                        {#if !org.is_default}
                          <Button variant="ghost" size="sm" disabled={saving} onclick={() => (suspendTarget = org)}>
                            Suspend
                          </Button>
                        {/if}
                      {:else}
                        <Button variant="ghost" size="sm" disabled={saving} onclick={() => setStatus(org, "ACTIVE")}>
                          Reactivate
                        </Button>
                      {/if}
                    </div>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <Card.Title>Instance defaults</Card.Title>
          <Card.Description>
            The settings every organisation starts from. An organisation that changes one keeps its own value; the rest
            read straight through to here, so editing a value reaches every tenant that has not overridden it. A handful
            are marked <strong>instance only</strong>: those cannot be overridden at all, because they decide how people
            log in and how long data is kept.
          </Card.Description>
        </div>
        <Button variant="outline" size="sm" onclick={openDefaults}>
          {defaultsOpen ? "Hide" : "Show"}
        </Button>
      </div>
    </Card.Header>
    {#if defaultsOpen}
      <Card.Content class="flex flex-col gap-3">
        <input
          class="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring w-full max-w-sm rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          placeholder="Filter settings"
          bind:value={filter}
        />
        {#if defaultsLoading}
          <div class="flex justify-center p-6"><Spinner /></div>
        {:else}
          <div class="overflow-x-auto">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Setting</Table.Head>
                  <Table.Head>Value</Table.Head>
                  <Table.Head class="w-24"></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each visibleDefaults as entry (entry.key)}
                  <Table.Row>
                    <Table.Cell class="align-top">
                      <div class="flex flex-col gap-1">
                        <span class="font-medium break-all">{entry.key}</span>
                        {#if entry.instance_scoped}
                          <span><Badge variant="secondary">instance only</Badge></span>
                        {/if}
                      </div>
                    </Table.Cell>
                    <Table.Cell class="text-muted-foreground align-top font-mono text-xs break-all whitespace-normal">
                      {entry.value === null ? "not set" : entry.value.slice(0, 200)}
                      {#if entry.value && entry.value.length > 200}&hellip;{/if}
                    </Table.Cell>
                    <Table.Cell class="align-top">
                      <Button variant="outline" size="sm" disabled={saving} onclick={() => editDefault(entry)}>
                        Edit
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                {:else}
                  <Table.Row>
                    <Table.Cell colspan={3} class="text-muted-foreground text-center text-sm">
                      Nothing matches that filter.
                    </Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </div>
        {/if}
      </Card.Content>
    {/if}
  </Card.Root>
</div>

<Dialog.Root open={detail !== null} onOpenChange={(open) => !open && (detail = null)}>
  <Dialog.Content class="max-h-[85vh] max-w-3xl overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>{detail?.name}</Dialog.Title>
      <Dialog.Description>
        How <code>{detail?.slug}</code> is configured and who can act in it. Nothing here can be changed from this screen.
      </Dialog.Description>
    </Dialog.Header>

    {#if detail}
      <div class="flex flex-col gap-6">
        <div class="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span>Monitor tag prefix: <code>{detail.tag_prefix || "(none)"}</code></span>
          <span>{detail.monitors} monitors</span>
          <span>{detail.pages} pages</span>
        </div>

        <div class="flex flex-col gap-2">
          <h3 class="text-sm font-medium">Hostnames</h3>
          {#if detail.domain_list.length === 0}
            <p class="text-muted-foreground text-sm">
              None. This organisation is reached at <code>/o/{detail.slug}/</code> only.
            </p>
          {:else}
            <div class="flex flex-col gap-1">
              {#each detail.domain_list as domain (domain.id)}
                <div class="flex flex-wrap items-center gap-2 text-sm">
                  <code>{domain.hostname}</code>
                  <Badge variant={domain.status === "ACTIVE" ? "secondary" : "outline"}>{domain.status}</Badge>
                </div>
              {/each}
            </div>
            {#if detail.status !== "ACTIVE"}
              <p class="text-muted-foreground text-xs">None of these resolve while the organisation is suspended.</p>
            {/if}
          {/if}
        </div>

        <div class="flex flex-col gap-2">
          <h3 class="text-sm font-medium">Members</h3>
          {#if detail.member_list.length === 0}
            <p class="text-muted-foreground text-sm">
              Nobody. No one can administer this organisation, and no screen inside it can fix that.
            </p>
          {:else}
            <div class="overflow-x-auto">
              <Table.Root>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>User</Table.Head>
                    <Table.Head>Roles here</Table.Head>
                    <Table.Head>Owner</Table.Head>
                    <Table.Head>Account</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {#each detail.member_list as member (member.user_id)}
                    <Table.Row>
                      <Table.Cell>
                        <div class="flex flex-col">
                          <span class="font-medium">{member.name || member.email}</span>
                          <span class="text-muted-foreground text-xs">{member.email}</span>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        {#if member.role_ids.length === 0}
                          <span class="text-muted-foreground text-xs">none</span>
                        {:else}
                          <div class="flex flex-wrap gap-1">
                            {#each member.role_ids as roleId (roleId)}
                              <Badge variant="secondary">{roleId}</Badge>
                            {/each}
                          </div>
                        {/if}
                      </Table.Cell>
                      <Table.Cell>
                        {#if member.is_owner}
                          <CheckIcon class="size-4" />
                        {/if}
                      </Table.Cell>
                      <Table.Cell>
                        {#if member.is_active}
                          <span class="text-muted-foreground text-xs">Active</span>
                        {:else}
                          <Badge variant="destructive">Deactivated</Badge>
                        {/if}
                      </Table.Cell>
                    </Table.Row>
                  {/each}
                </Table.Body>
              </Table.Root>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root open={suspendTarget !== null} onOpenChange={(open) => !open && (suspendTarget = null)}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Suspend {suspendTarget?.name}?</AlertDialog.Title>
      <AlertDialog.Description>
        Nothing is deleted. The organisation stops being found: its monitors stop being checked, its rollups,
        maintenance windows and scheduled reports stop running, it disappears from everyone's organisation switcher, and
        both <code>/o/{suspendTarget?.slug}/</code> and its custom hostnames stop resolving. Reactivating it from this screen
        puts all of that back.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={() => suspendTarget && setStatus(suspendTarget, "SUSPENDED")}>
        Suspend
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<!--
  Editing one default.

  The value is a raw string because that is what `site_data` stores and what the
  key's own validator checks - an object-typed key holds JSON text. Rendering a
  typed form per key would mean reimplementing every validator in the browser and
  drifting from the server's, which is the one copy that decides.

  `break-all` rather than `truncate` on the key: a single truncating child inside
  a grid dialog sizes its track to the whole string and pushes the footer out of
  the panel onto the overlay, where clicks are swallowed.
-->
<Dialog.Root open={editingKey !== null} onOpenChange={(open) => !open && (editingKey = null)}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title class="break-all">{editingKey?.key}</Dialog.Title>
      <Dialog.Description>
        {#if editingKey?.instance_scoped}
          Instance only. Every organisation uses this value and none can override it.
        {:else}
          The default for every organisation that has not set its own. Organisations that already changed this keep
          their value.
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    <textarea
      class="border-input bg-background ring-offset-background focus-visible:ring-ring min-h-40 w-full rounded-md border p-3 font-mono text-xs focus-visible:ring-2 focus-visible:outline-none"
      bind:value={editingValue}
      spellcheck="false"
    ></textarea>
    <p class="text-muted-foreground text-xs">
      Stored as {editingKey?.data_type}. Rejected by the same validator the settings screens use, so an invalid value
      fails here rather than reaching a tenant.
    </p>

    <Dialog.Footer class="gap-2 sm:justify-end">
      <Button variant="outline" disabled={saving} onclick={() => (editingKey = null)}>Cancel</Button>
      <Button disabled={saving} onclick={saveDefault}>Save</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
