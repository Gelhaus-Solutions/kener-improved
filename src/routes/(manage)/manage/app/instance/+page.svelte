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
