<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import Plus from "@lucide/svelte/icons/plus";
  import Loader from "@lucide/svelte/icons/loader";
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";
  import KeyIcon from "@lucide/svelte/icons/key";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Ban from "@lucide/svelte/icons/ban";
  import { toast } from "svelte-sonner";
  import LocalTime from "$lib/components/LocalTime.svelte";
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import { page } from "$app/state";
  import { API_KEY_SCOPES, WILDCARD_SCOPE, parseScopes } from "$lib/apiScopes.js";

  interface ApiKey {
    id: number;
    name: string;
    masked_key: string;
    status: string;
    created_at: string;
    scopes: string;
    expires_at: number | null;
    last_used_at: number | null;
    key_prefix: string | null;
    rotated_from: number | null;
    revoked_at: number | null;
  }

  // State
  let apiKeys = $state<ApiKey[]>([]);
  let loading = $state(true);
  let creating = $state(false);
  let showCreateDialog = $state(false);
  let newAPIKeyName = $state("");
  let newKeyResp = $state<{ apiKey?: string }>({});
  let copied = $state(false);
  let deleteDialogOpen = $state(false);
  let keyToDelete = $state<ApiKey | null>(null);
  let deleting = $state(false);

  // Scope picker. `fullAccess` is a separate flag rather than "*" living in the
  // selected set, because the two are mutually exclusive in the UI and the
  // server collapses them anyway.
  let fullAccess = $state(false);
  let selectedScopes = $state<string[]>([]);
  let expiryDays = $state("0");

  let rotateDialogOpen = $state(false);
  let keyToRotate = $state<ApiKey | null>(null);
  let rotating = $state(false);
  let revokeDialogOpen = $state(false);
  let keyToRevoke = $state<ApiKey | null>(null);
  let revoking = $state(false);

  const EXPIRY_OPTIONS = [
    { value: "0", label: "Never expires" },
    { value: "30", label: "30 days" },
    { value: "90", label: "90 days" },
    { value: "180", label: "180 days" },
    { value: "365", label: "1 year" }
  ];

  // A key can never carry a permission its creator lacks; the server enforces
  // that and would reject the request. Reflecting it here means the picker never
  // offers a choice that is going to come back as an error.
  const myPermissions = $derived(new Set<string>(page.data.userPermissions ?? []));
  const grantable = $derived(API_KEY_SCOPES.filter((p) => myPermissions.has(p.id)));
  const canGrantFullAccess = $derived(API_KEY_SCOPES.every((p) => myPermissions.has(p.id)));

  /** Grouped by the part before the dot, which is how the roles screen reads too. */
  const scopeGroups = $derived.by(() => {
    const groups: Array<[string, Array<{ id: string; permission_name: string }>]> = [];
    for (const perm of grantable) {
      const domain = perm.id.split(".")[0];
      const existing = groups.find(([name]) => name === domain);
      if (existing) existing[1].push(perm);
      else groups.push([domain, [perm]]);
    }
    return groups;
  });

  const expiryLabel = $derived(EXPIRY_OPTIONS.find((o) => o.value === expiryDays)?.label ?? "Never expires");

  function scopesOf(apiKey: ApiKey): string[] {
    return parseScopes(apiKey.scopes);
  }

  function scopeSummary(apiKey: ApiKey): string {
    const scopes = scopesOf(apiKey);
    if (scopes.includes(WILDCARD_SCOPE)) return "Full access";
    if (scopes.length === 0) return "No access";
    return `${scopes.length} ${scopes.length === 1 ? "scope" : "scopes"}`;
  }

  function scopeTitle(apiKey: ApiKey): string {
    const scopes = scopesOf(apiKey);
    if (scopes.includes(WILDCARD_SCOPE)) return "Every permission, including ones added in future releases";
    return scopes.join("\n");
  }

  /** The key that replaced this one, if it has been rotated. */
  function replacementOf(apiKey: ApiKey): ApiKey | undefined {
    return apiKeys.find((k) => k.rotated_from === apiKey.id);
  }

  function hoursUntil(epochSeconds: number): number {
    return Math.max(0, Math.ceil((epochSeconds - Date.now() / 1000) / 3600));
  }

  function expiryText(apiKey: ApiKey): string {
    if (apiKey.revoked_at) return "Revoked";
    if (apiKey.expires_at === null) return "Never";
    const hours = hoursUntil(apiKey.expires_at);
    if (hours === 0) return "Expired";
    if (hours < 48) return `in ${hours}h`;
    return `in ${Math.ceil(hours / 24)}d`;
  }

  function resetCreateForm() {
    newAPIKeyName = "";
    fullAccess = false;
    selectedScopes = [];
    expiryDays = "0";
  }

  function toggleScope(id: string, checked: boolean) {
    selectedScopes = checked ? [...selectedScopes, id] : selectedScopes.filter((s) => s !== id);
  }

  async function callManage(action: string, data: unknown) {
    const response = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    return await response.json();
  }

  async function loadAPIKeys() {
    loading = true;
    try {
      const result = await callManage("getAPIKeys", {});
      if (result.error) {
        toast.error(result.error);
      } else {
        apiKeys = result;
      }
    } catch (e) {
      toast.error("Failed to load API keys");
    } finally {
      loading = false;
    }
  }

  async function createNewAPIKey() {
    if (!newAPIKeyName.trim()) {
      toast.error("Please enter a name for the API key");
      return;
    }
    const scopes = fullAccess ? [WILDCARD_SCOPE] : selectedScopes;
    if (scopes.length === 0) {
      toast.error("Select at least one scope, or grant full access");
      return;
    }

    creating = true;
    try {
      const result = await callManage("createNewApiKey", {
        name: newAPIKeyName,
        scopes,
        expires_in_days: Number(expiryDays)
      });
      if (result.error) {
        toast.error(result.error);
      } else {
        newKeyResp = result;
        toast.success("API key created successfully");
        loadAPIKeys();
        showCreateDialog = false;
        resetCreateForm();
      }
    } catch (e) {
      toast.error("Failed to create API key");
    } finally {
      creating = false;
    }
  }

  async function updateStatus(apiKey: ApiKey) {
    const newStatus = apiKey.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    try {
      const result = await callManage("updateApiKeyStatus", { id: apiKey.id, status: newStatus });
      if (result.error) {
        toast.error(result.error);
      } else {
        apiKey.status = newStatus;
        apiKeys = [...apiKeys];
        toast.success(`API key ${newStatus === "ACTIVE" ? "activated" : "deactivated"}`);
      }
    } catch (e) {
      toast.error("Failed to update API key status");
    }
  }

  function openDeleteDialog(apiKey: ApiKey) {
    keyToDelete = apiKey;
    deleteDialogOpen = true;
  }

  async function deleteApiKey() {
    if (!keyToDelete) return;

    deleting = true;
    try {
      const result = await callManage("deleteApiKey", { id: keyToDelete.id });
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("API key deleted successfully");
        await loadAPIKeys();
      }
    } catch (e) {
      toast.error("Failed to delete API key");
    } finally {
      deleting = false;
      deleteDialogOpen = false;
      keyToDelete = null;
    }
  }

  function openRotateDialog(apiKey: ApiKey) {
    keyToRotate = apiKey;
    rotateDialogOpen = true;
  }

  async function rotateApiKey() {
    if (!keyToRotate) return;

    rotating = true;
    try {
      const result = await callManage("rotateApiKey", { id: keyToRotate.id });
      if (result.error) {
        toast.error(result.error);
      } else {
        newKeyResp = result;
        toast.success("API key rotated. The old key keeps working for 24 hours.");
        await loadAPIKeys();
      }
    } catch (e) {
      toast.error("Failed to rotate API key");
    } finally {
      rotating = false;
      rotateDialogOpen = false;
      keyToRotate = null;
    }
  }

  function openRevokeDialog(apiKey: ApiKey) {
    keyToRevoke = apiKey;
    revokeDialogOpen = true;
  }

  async function revokeApiKey() {
    if (!keyToRevoke) return;

    revoking = true;
    try {
      const result = await callManage("revokeApiKey", { id: keyToRevoke.id });
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("API key revoked");
        await loadAPIKeys();
      }
    } catch (e) {
      toast.error("Failed to revoke API key");
    } finally {
      revoking = false;
      revokeDialogOpen = false;
      keyToRevoke = null;
    }
  }

  function copyKey() {
    if (newKeyResp.apiKey) {
      navigator.clipboard.writeText(newKeyResp.apiKey);
      copied = true;
      toast.success("API key copied to clipboard");
      setTimeout(() => {
        copied = false;
      }, 2000);
    }
  }

  function dismissNewKey() {
    newKeyResp = {};
  }

  onMount(() => {
    loadAPIKeys();
  });
</script>

<div class="flex w-full flex-col gap-4 p-4">
  <!-- Breadcrumb -->

  <!-- Header with Create Button -->
  <div class="flex items-center justify-end">
    <Button onclick={() => (showCreateDialog = true)}>
      <Plus class="h-4 w-4" />
      Create New API Key
    </Button>
  </div>

  <!-- New Key Alert -->
  {#if newKeyResp.apiKey}
    <Card.Root class="border-green-600 bg-green-50 dark:bg-green-950/20">
      <Card.Content class="">
        <div class="flex items-start gap-3">
          <div class="flex-1">
            <p class="font-medium text-green-800 dark:text-green-200">🎉 API Key Created Successfully</p>
            <div class="relative mt-2">
              <code class="bg-background block rounded-md border px-4 py-2 pr-12 font-mono text-sm">
                {newKeyResp.apiKey}
              </code>
              <Button
                size="icon"
                variant="ghost"
                class="absolute top-1/2 right-2 h-7 w-7 -translate-y-1/2"
                onclick={copyKey}
              >
                {#if copied}
                  <Check class="h-4 w-4 text-green-500" />
                {:else}
                  <Copy class="h-4 w-4" />
                {/if}
              </Button>
            </div>
            <p class="text-muted-foreground mt-2 text-xs">
              Your new API key has been created. It will <strong class="uppercase underline">not be shown again</strong
              >, so make sure to save it.
            </p>
          </div>
          <Button size="sm" variant="ghost" onclick={dismissNewKey}>Dismiss</Button>
        </div>
      </Card.Content>
    </Card.Root>
  {/if}

  <!-- API Keys Table -->
  <Card.Root>
    <Card.Content class="p-0">
      {#if loading}
        <div class="flex items-center justify-center py-12">
          <Spinner class="h-6 w-6" />
        </div>
      {:else if apiKeys.length === 0}
        <div class="text-muted-foreground py-12 text-center">
          <KeyIcon class="mx-auto mb-4 h-12 w-12 opacity-50" />
          <p>No API keys found</p>
          <p class="text-sm">Create your first API key to get started</p>
        </div>
      {:else}
        <Table.Root class="p-4">
          <Table.Header>
            <Table.Row>
              <Table.Head class="pl-4">Name</Table.Head>
              <Table.Head>Scopes</Table.Head>
              <Table.Head>Last used</Table.Head>
              <Table.Head>Expires</Table.Head>
              <Table.Head>Created At</Table.Head>
              <Table.Head class="pr-4 text-right">Status</Table.Head>
              <Table.Head class="pr-4 text-right">Actions</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each apiKeys as apiKey (apiKey.id)}
              {@const replacement = replacementOf(apiKey)}
              <Table.Row class={apiKey.revoked_at ? "opacity-60" : ""}>
                <Table.Cell class="pl-4">
                  <div class="font-medium">{apiKey.name}</div>
                  <code class="text-muted-foreground text-xs">
                    {apiKey.key_prefix ? `${apiKey.key_prefix}…` : ""}{apiKey.masked_key.slice(-8)}
                  </code>
                  {#if replacement}
                    <div class="text-muted-foreground mt-1 text-xs">
                      Rotated, replaced by “{replacement.name}”
                    </div>
                  {/if}
                </Table.Cell>
                <Table.Cell>
                  <Badge
                    variant={scopesOf(apiKey).includes(WILDCARD_SCOPE) ? "destructive" : "secondary"}
                    title={scopeTitle(apiKey)}
                  >
                    {scopeSummary(apiKey)}
                  </Badge>
                </Table.Cell>
                <Table.Cell class="text-muted-foreground text-sm">
                  {#if apiKey.last_used_at}
                    <LocalTime value={apiKey.last_used_at} format="MMM d, yyyy HH:mm" />
                  {:else}
                    Never
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-muted-foreground text-sm">
                  {expiryText(apiKey)}
                </Table.Cell>
                <Table.Cell class="text-muted-foreground text-sm">
                  <LocalTime value={apiKey.created_at} format="MMM d, yyyy HH:mm" />
                </Table.Cell>
                <Table.Cell class="pr-4 text-right">
                  <div class="flex items-center justify-end gap-2">
                    <span class="text-muted-foreground text-xs">
                      {apiKey.revoked_at ? "Revoked" : apiKey.status === "ACTIVE" ? "Active" : "Inactive"}
                    </span>
                    <Switch
                      checked={apiKey.status === "ACTIVE"}
                      disabled={!!apiKey.revoked_at}
                      onCheckedChange={() => updateStatus(apiKey)}
                    />
                  </div>
                </Table.Cell>
                <Table.Cell class="pr-4 text-right">
                  <div class="flex items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!apiKey.revoked_at}
                      onclick={() => openRotateDialog(apiKey)}
                    >
                      <RefreshCw class="h-4 w-4" />
                      Rotate
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!apiKey.revoked_at}
                      onclick={() => openRevokeDialog(apiKey)}
                    >
                      <Ban class="h-4 w-4" />
                      Revoke
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={!page.data.userPermissions?.includes("api_keys.delete")}
                      size="sm"
                      onclick={() => openDeleteDialog(apiKey)}
                    >
                      <Trash2 class="h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {/if}
    </Card.Content>
  </Card.Root>
</div>
<Dialog.Root bind:open={showCreateDialog}>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Create a new API Key</Dialog.Title>
      <Dialog.Description>
        A key can only be granted permissions you hold yourself. Grant it the narrowest set that does the job: unlike a
        password, a key is usually deployed somewhere it can be read.
      </Dialog.Description>
    </Dialog.Header>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        createNewAPIKey();
      }}
    >
      <div class="grid max-h-[60vh] gap-4 overflow-y-auto py-4">
        <div class="grid gap-2">
          <Label for="newAPIKeyName">Name</Label>
          <Input id="newAPIKeyName" bind:value={newAPIKeyName} placeholder="eg. My API Key" required />
        </div>

        <div class="grid gap-2">
          <Label for="expiry">Expiry</Label>
          <Select.Root type="single" bind:value={expiryDays}>
            <Select.Trigger id="expiry" class="w-full">{expiryLabel}</Select.Trigger>
            <Select.Content>
              {#each EXPIRY_OPTIONS as option (option.value)}
                <Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>

        <div class="grid gap-2">
          <Label>Scopes</Label>
          {#if canGrantFullAccess}
            <label class="flex items-start gap-2 rounded-md border p-3">
              <Checkbox checked={fullAccess} onCheckedChange={(v) => (fullAccess = v === true)} />
              <span class="text-sm">
                <span class="font-medium">Full access</span>
                <span class="text-muted-foreground block text-xs">
                  Every permission, including ones added in future releases. This is what keys created before scoping
                  existed carry.
                </span>
              </span>
            </label>
          {/if}

          <div class="grid gap-4 {fullAccess ? 'pointer-events-none opacity-40' : ''}">
            {#each scopeGroups as [domain, perms] (domain)}
              <div class="grid gap-1">
                <div class="text-muted-foreground text-xs font-semibold uppercase">{domain.replace(/_/g, " ")}</div>
                {#each perms as perm (perm.id)}
                  <label class="flex items-start gap-2">
                    <Checkbox
                      checked={selectedScopes.includes(perm.id)}
                      onCheckedChange={(v) => toggleScope(perm.id, v === true)}
                    />
                    <span class="text-sm">
                      <code class="text-xs">{perm.id}</code>
                      <span class="text-muted-foreground block text-xs">{perm.permission_name}</span>
                    </span>
                  </label>
                {/each}
              </div>
            {/each}
          </div>
        </div>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (showCreateDialog = false)}>Cancel</Button>
        <Button type="submit" disabled={creating}>
          {#if creating}
            <Loader class="h-4 w-4 animate-spin" />
          {/if}
          Create
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={rotateDialogOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Rotate API Key</AlertDialog.Title>
      <AlertDialog.Description>
        A new secret will be issued for "{keyToRotate?.name}" with the same scopes. The current secret keeps working for
        24 hours so deployments can catch up, then stops. Revoke it sooner once you have confirmed the new one works.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={rotating}>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={rotateApiKey} disabled={rotating}>
        {#if rotating}
          <Spinner class="h-4 w-4" />
        {/if}
        Rotate
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={revokeDialogOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Revoke API Key</AlertDialog.Title>
      <AlertDialog.Description>
        "{keyToRevoke?.name}" will stop authenticating immediately and cannot be re-enabled. The row stays in this list
        so there is still a record of it. Anything using this secret will start receiving 401s.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={revoking}>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={revokeApiKey} disabled={revoking}>
        {#if revoking}
          <Spinner class="h-4 w-4" />
        {/if}
        Revoke
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={deleteDialogOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete API Key</AlertDialog.Title>
      <AlertDialog.Description>
        Are you sure you want to delete API key "{keyToDelete?.name}"? This action cannot be undone.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={deleting}>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={deleteApiKey} disabled={deleting}>
        {#if deleting}
          <Spinner class="h-4 w-4" />
        {/if}
        Delete
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
