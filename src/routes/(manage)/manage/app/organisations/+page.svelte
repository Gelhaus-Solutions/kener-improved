<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import CheckIcon from "@lucide/svelte/icons/check";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import { toast } from "svelte-sonner";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";

  interface OrgDomain {
    id: number;
    hostname: string;
    status: string;
  }

  interface OrgDetail {
    id: number;
    slug: string;
    name: string;
    tag_prefix: string;
    is_default: boolean;
    domains: OrgDomain[];
  }

  interface OrgMember {
    user_id: number;
    email: string;
    name: string;
    is_active: boolean;
    is_owner: boolean;
    role_ids: string[];
  }

  interface Role {
    id: string;
    role_name: string;
  }

  type MyOrg = { id: number; slug: string; name: string; is_owner: boolean; is_default: boolean };

  // Which controls are shown is decided by the same permission ids the actions
  // enforce, so a member holding only `orgs.read` sees the screen without the
  // buttons that would 403 rather than a screen full of traps.
  const can = (permission: string) => (page.data.userPermissions ?? []).includes(permission);
  const canWriteOrg = can("orgs.write");
  const canReadMembers = can("orgs.members.read");
  const canWriteMembers = can("orgs.members.write");
  const canCreateOrg = page.data.canCreateOrg as boolean;

  let myOrgs = $derived((page.data.orgs ?? []) as MyOrg[]);
  let activeOrgId = $derived(page.data.activeOrgId as number);

  let org = $state<OrgDetail | null>(null);
  let members = $state<OrgMember[]>([]);
  let roles = $state<Role[]>([]);
  let loading = $state(true);
  let saving = $state(false);

  let formName = $state("");
  let formSlug = $state("");

  let newHostname = $state("");
  let removeDomainTarget = $state<OrgDomain | null>(null);

  let showAddMember = $state(false);
  let memberEmail = $state("");
  let memberRoleId = $state("");
  let memberIsOwner = $state(false);
  let removeMemberTarget = $state<OrgMember | null>(null);

  let showCreate = $state(false);
  let createName = $state("");
  let createSlug = $state("");

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
      org = await call("getOrganisation");
      formName = org?.name ?? "";
      formSlug = org?.slug ?? "";
      if (canReadMembers) members = await call("getOrgMembers");
      // The roles of *this* org, because that is what a new member can be given.
      // Reading them is `roles.read`, which somebody managing members may not
      // hold; without it the add form simply has no role list and stays closed.
      if (canWriteMembers && can("roles.read")) {
        const resp = await call("getRoles");
        roles = Array.isArray(resp) ? resp : (resp?.roles ?? []);
        memberRoleId = roles[0]?.id ?? "";
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load this organisation");
    } finally {
      loading = false;
    }
  }

  async function run(fn: () => Promise<unknown>, success: string) {
    saving = true;
    try {
      await fn();
      toast.success(success);
      await load();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
      return false;
    } finally {
      saving = false;
    }
  }

  const saveDetails = () =>
    run(() => call("updateOrganisation", { name: formName, slug: formSlug }), "Organisation updated");

  const addDomain = async () => {
    if (await run(() => call("addOrgDomain", { hostname: newHostname }), "Hostname added")) newHostname = "";
  };

  const removeDomain = async (domain: OrgDomain) => {
    removeDomainTarget = null;
    await run(() => call("removeOrgDomain", { id: domain.id }), "Hostname removed");
  };

  const addMember = async () => {
    const ok = await run(
      () => call("addOrgMember", { email: memberEmail, role_id: memberRoleId, is_owner: memberIsOwner }),
      "Member added"
    );
    if (ok) {
      showAddMember = false;
      memberEmail = "";
      memberIsOwner = false;
    }
  };

  const setOwner = (member: OrgMember, isOwner: boolean) =>
    run(
      () => call("setOrgMemberOwner", { user_id: member.user_id, is_owner: isOwner }),
      isOwner ? "Member is now an owner" : "Member is no longer an owner"
    );

  const removeMember = async (member: OrgMember) => {
    removeMemberTarget = null;
    await run(() => call("removeOrgMember", { user_id: member.user_id }), "Member removed");
  };

  const createOrg = async () => {
    saving = true;
    try {
      const created = await call("createOrganisation", { name: createName, slug: createSlug });
      // Straight into the new org: it has been provisioned and the creator owns
      // it, and the only useful next step is to set it up. Switching here rather
      // than leaving them in the old one also proves, immediately, that the org
      // they just made actually works.
      await call("switchOrg", { org_id: created.id });
      window.location.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the organisation");
      saving = false;
    }
  };

  onMount(load);
</script>

<div class="flex w-full flex-col gap-4 p-4">
  {#if loading}
    <div class="flex justify-center p-8"><Spinner /></div>
  {:else if !org}
    <p class="text-muted-foreground">This organisation could not be loaded.</p>
  {:else}
    <Card.Root>
      <Card.Header>
        <Card.Title>This organisation</Card.Title>
        <Card.Description>
          The organisation you are currently acting in. Switch organisation in the sidebar to administer another one.
        </Card.Description>
      </Card.Header>
      <Card.Content class="flex flex-col gap-4">
        <div class="grid gap-4 @md/main:grid-cols-2">
          <div class="flex flex-col gap-2">
            <Label for="org-name">Name</Label>
            <Input id="org-name" bind:value={formName} disabled={!canWriteOrg || saving} />
          </div>
          <div class="flex flex-col gap-2">
            <Label for="org-slug">Slug</Label>
            <Input id="org-slug" bind:value={formSlug} disabled={!canWriteOrg || saving} />
            <p class="text-muted-foreground text-xs">
              Used in monitor URLs and in the <code>/o/{org.slug}/</code> path prefix. Changing it changes those links.
            </p>
          </div>
        </div>

        <div class="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <span>Monitor tag prefix:</span>
          <code>{org.tag_prefix || "(none)"}</code>
          <span> Fixed after creation, because it is baked into every monitor tag this organisation already has. </span>
          {#if org.is_default}
            <Badge variant="secondary">Default organisation</Badge>
          {/if}
        </div>

        {#if canWriteOrg}
          <div>
            <Button onclick={saveDetails} disabled={saving}>
              {#if saving}<Spinner class="size-4" />{/if}
              Save
            </Button>
          </div>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Hostnames</Card.Title>
        <Card.Description>
          A request arriving on one of these hostnames serves this organisation's status page. Admin traffic is not
          affected: which organisation you administer comes from your session, not from the hostname.
        </Card.Description>
      </Card.Header>
      <Card.Content class="flex flex-col gap-4">
        {#if org.domains.length === 0}
          <p class="text-muted-foreground text-sm">
            No hostnames yet. This organisation is reachable at
            <code>/o/{org.slug}/</code> until one is added.
          </p>
        {:else}
          <div class="overflow-x-auto">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Hostname</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each org.domains as domain (domain.id)}
                  <Table.Row>
                    <Table.Cell class="font-medium">{domain.hostname}</Table.Cell>
                    <Table.Cell>
                      <Badge variant={domain.status === "ACTIVE" ? "default" : "secondary"}>{domain.status}</Badge>
                    </Table.Cell>
                    <Table.Cell class="text-end">
                      {#if canWriteOrg}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={saving}
                          onclick={() => (removeDomainTarget = domain)}
                        >
                          <Trash2 class="size-4" />
                        </Button>
                      {/if}
                    </Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </div>
        {/if}

        {#if canWriteOrg}
          <form
            class="flex flex-wrap items-end gap-2"
            onsubmit={(e) => {
              e.preventDefault();
              addDomain();
            }}
          >
            <div class="flex min-w-64 flex-1 flex-col gap-2">
              <Label for="new-hostname">Add a hostname</Label>
              <Input id="new-hostname" bind:value={newHostname} placeholder="status.example.com" disabled={saving} />
            </div>
            <Button type="submit" disabled={saving || !newHostname.trim()}>
              <Plus class="size-4" />
              Add
            </Button>
          </form>
        {/if}
      </Card.Content>
    </Card.Root>

    {#if canReadMembers}
      <Card.Root>
        <Card.Header class="flex flex-row items-center justify-between gap-2">
          <div>
            <Card.Title>Members</Card.Title>
            <Card.Description>
              Who may act in this organisation, and what they hold in it. A person is one account across every
              organisation; removing them here revokes this membership only.
            </Card.Description>
          </div>
          {#if canWriteMembers}
            <Button size="sm" onclick={() => (showAddMember = true)}>
              <Plus class="size-4" />
              Add member
            </Button>
          {/if}
        </Card.Header>
        <Card.Content>
          <div class="overflow-x-auto">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head>User</Table.Head>
                  <Table.Head>Roles here</Table.Head>
                  <Table.Head>Owner</Table.Head>
                  <Table.Head></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each members as member (member.user_id)}
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
                      {#if canWriteMembers}
                        <Checkbox
                          checked={member.is_owner}
                          disabled={saving}
                          onCheckedChange={(checked) => setOwner(member, checked === true)}
                          aria-label="Organisation owner"
                        />
                      {:else if member.is_owner}
                        <CheckIcon class="size-4" />
                      {/if}
                    </Table.Cell>
                    <Table.Cell class="text-end">
                      {#if canWriteMembers && member.user_id !== page.data.userDb.id}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={saving}
                          onclick={() => (removeMemberTarget = member)}
                        >
                          <Trash2 class="size-4" />
                        </Button>
                      {/if}
                    </Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </div>
        </Card.Content>
      </Card.Root>
    {/if}

    <Card.Root>
      <Card.Header class="flex flex-row items-center justify-between gap-2">
        <div>
          <Card.Title>Your organisations</Card.Title>
          <Card.Description>Every organisation you belong to. Switching one in reloads the admin.</Card.Description>
        </div>
        {#if canCreateOrg}
          <Button size="sm" onclick={() => (showCreate = true)}>
            <Plus class="size-4" />
            New organisation
          </Button>
        {/if}
      </Card.Header>
      <Card.Content>
        <div class="overflow-x-auto">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Name</Table.Head>
                <Table.Head>Slug</Table.Head>
                <Table.Head></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each myOrgs as myOrg (myOrg.id)}
                <Table.Row>
                  <Table.Cell class="font-medium">
                    {myOrg.name}
                    {#if myOrg.id === activeOrgId}
                      <Badge variant="secondary" class="ms-2">Current</Badge>
                    {/if}
                    {#if myOrg.is_owner}
                      <Badge variant="outline" class="ms-2">Owner</Badge>
                    {/if}
                  </Table.Cell>
                  <Table.Cell><code>{myOrg.slug}</code></Table.Cell>
                  <Table.Cell class="text-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      href={clientResolver(resolve, `/o/${myOrg.slug}/`)}
                      target="_blank"
                      rel="noopener"
                    >
                      <ExternalLinkIcon class="size-4" />
                      Status page
                    </Button>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>
      </Card.Content>
    </Card.Root>
  {/if}
</div>

<Dialog.Root bind:open={showAddMember}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>Add a member</Dialog.Title>
      <Dialog.Description>
        The person must already have an account on this instance. Invite new people from the Users screen.
      </Dialog.Description>
    </Dialog.Header>
    <form
      class="flex flex-col gap-4"
      onsubmit={(e) => {
        e.preventDefault();
        addMember();
      }}
    >
      <div class="flex flex-col gap-2">
        <Label for="member-email">Email address</Label>
        <Input id="member-email" bind:value={memberEmail} placeholder="person@example.com" disabled={saving} />
      </div>
      <div class="flex flex-col gap-2">
        <Label for="member-role">Role in this organisation</Label>
        {#if roles.length === 0}
          <p class="text-muted-foreground text-xs">
            No roles could be listed, which needs the "View roles" permission. A member cannot be added without one.
          </p>
        {:else}
          <Select.Root type="single" value={memberRoleId} onValueChange={(value) => (memberRoleId = value ?? "")}>
            <Select.Trigger id="member-role" class="w-full">
              {roles.find((role) => role.id === memberRoleId)?.role_name ?? "Choose a role"}
            </Select.Trigger>
            <Select.Content>
              {#each roles as role (role.id)}
                <Select.Item value={role.id}>{role.role_name}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        {/if}
      </div>
      <div class="flex items-center gap-2">
        <Checkbox id="member-owner" bind:checked={memberIsOwner} disabled={saving} />
        <Label for="member-owner">Make them an owner of this organisation</Label>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (showAddMember = false)}>Cancel</Button>
        <Button type="submit" disabled={saving || !memberEmail.trim() || !memberRoleId}>
          {#if saving}<Spinner class="size-4" />{/if}
          Add
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={showCreate}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>New organisation</Dialog.Title>
      <Dialog.Description>
        It starts with its own roles, monitors, status page, settings and email templates, exactly as a fresh install
        does. You become its owner and are switched into it.
      </Dialog.Description>
    </Dialog.Header>
    <form
      class="flex flex-col gap-4"
      onsubmit={(e) => {
        e.preventDefault();
        createOrg();
      }}
    >
      <div class="flex flex-col gap-2">
        <Label for="create-name">Name</Label>
        <Input id="create-name" bind:value={createName} placeholder="Acme Inc" disabled={saving} />
      </div>
      <div class="flex flex-col gap-2">
        <Label for="create-slug">Slug</Label>
        <Input id="create-slug" bind:value={createSlug} placeholder="acme" disabled={saving} />
        <p class="text-muted-foreground text-xs">
          Lowercase letters, digits and hyphens. Becomes the <code>/o/&lt;slug&gt;/</code> path and the prefix on this organisation's
          monitor tags, and cannot be used as a tag prefix by anyone else.
        </p>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (showCreate = false)}>Cancel</Button>
        <Button type="submit" disabled={saving || !createName.trim() || !createSlug.trim()}>
          {#if saving}<Spinner class="size-4" />{/if}
          Create
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root open={removeDomainTarget !== null} onOpenChange={(open) => !open && (removeDomainTarget = null)}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Remove this hostname?</AlertDialog.Title>
      <AlertDialog.Description>
        <code>{removeDomainTarget?.hostname}</code> will stop serving this organisation's status page. Anyone visiting it
        will see the default organisation instead.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={() => removeDomainTarget && removeDomain(removeDomainTarget)}>
        Remove
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root open={removeMemberTarget !== null} onOpenChange={(open) => !open && (removeMemberTarget = null)}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Remove this member?</AlertDialog.Title>
      <AlertDialog.Description>
        {removeMemberTarget?.email} will lose access to this organisation and the roles they hold in it. Their account on
        this instance, and their membership of any other organisation, is untouched.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={() => removeMemberTarget && removeMember(removeMemberTarget)}>
        Remove
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
