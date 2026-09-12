<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import Plus from "@lucide/svelte/icons/plus";
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";
  import SendIcon from "@lucide/svelte/icons/send";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import WebhookIcon from "@lucide/svelte/icons/webhook";
  import { toast } from "svelte-sonner";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import { subscribableEventsByDomain } from "$lib/event-taxonomy.js";

  interface Endpoint {
    id: number;
    name: string;
    url: string;
    status: "ACTIVE" | "DISABLED" | "DISABLED_AUTO";
    secret_hint: string | null;
    timeout_ms: number;
    consecutive_failures: number;
    last_success_at: number | null;
    last_failure_at: number | null;
    event_types: string[];
    /** E11. */
    format: "GENERIC" | "DISCORD";
    message_template: string | null;
  }

  // Grouped by domain, straight from the taxonomy. This is the reason the
  // taxonomy lives outside $lib/server: a client component has to render it.
  const domains = subscribableEventsByDomain();

  let endpoints = $state<Endpoint[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let testing = $state<number | null>(null);

  let showDialog = $state(false);
  let editing = $state<Endpoint | null>(null);
  let formName = $state("");
  let formUrl = $state("");
  let formTimeout = $state(10000);
  let formStatus = $state<"ACTIVE" | "DISABLED">("ACTIVE");
  let formEvents = $state<string[]>([]);
  // E11. What shape this endpoint receives, and what the operator wrote in it.
  let formFormat = $state<"GENERIC" | "DISCORD">("GENERIC");
  let formTemplate = $state("");

  // A literal, not an inline attribute: Svelte reads `{{type}}` in markup as an
  // expression, so the Mustache braces this feature is built on have to reach
  // the DOM as a plain string.
  const PLACEHOLDER_TEMPLATE = "<@&123456789> {{type}}: {{object.title}}";

  // Shown once, after a create or a rotate, and never retrievable again.
  let revealedSecret = $state<string | null>(null);
  let revealedFor = $state<string>("");
  let copied = $state(false);

  let deleteTarget = $state<Endpoint | null>(null);

  async function call(action: string, data: Record<string, unknown> = {}) {
    const res = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    const body = await res.json();
    if (!res.ok || body?.error) throw new Error(body?.error || "Request failed");
    return body;
  }

  async function load() {
    loading = true;
    try {
      endpoints = await call("getWebhookEndpoints");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load endpoints");
    } finally {
      loading = false;
    }
  }

  function openCreate() {
    editing = null;
    formName = "";
    formUrl = "";
    formTimeout = 10000;
    formStatus = "ACTIVE";
    formEvents = ["incident.*"];
    formFormat = "GENERIC";
    formTemplate = "";
    showDialog = true;
  }

  function openEdit(endpoint: Endpoint) {
    editing = endpoint;
    formName = endpoint.name;
    formUrl = endpoint.url;
    formTimeout = endpoint.timeout_ms;
    // DISABLED_AUTO is not offered: it means Kener stopped sending, and only
    // Kener sets it. Re-enabling is what an operator does instead.
    formStatus = endpoint.status === "ACTIVE" ? "ACTIVE" : "DISABLED";
    formEvents = [...endpoint.event_types];
    formFormat = endpoint.format === "DISCORD" ? "DISCORD" : "GENERIC";
    formTemplate = endpoint.message_template ?? "";
    showDialog = true;
  }

  function toggleEvent(type: string, checked: boolean) {
    formEvents = checked ? [...new Set([...formEvents, type])] : formEvents.filter((t) => t !== type);
  }

  // A domain wildcard already covers every type under it, so the individual
  // boxes are shown as implied rather than letting someone tick both and wonder
  // which one applies.
  function coveredByWildcard(type: string): boolean {
    return formEvents.includes(`${type.slice(0, type.indexOf("."))}.*`);
  }

  async function save() {
    if (!formName.trim()) return toast.error("Give the endpoint a name");
    if (!formUrl.trim()) return toast.error("Give the endpoint a URL");
    if (formEvents.length === 0) return toast.error("Select at least one event type");

    saving = true;
    try {
      if (editing) {
        await call("updateWebhookEndpoint", {
          id: editing.id,
          name: formName,
          url: formUrl,
          timeout_ms: formTimeout,
          status: formStatus,
          event_types: formEvents,
          format: formFormat,
          message_template: formTemplate
        });
        toast.success("Endpoint updated");
      } else {
        const result = await call("createWebhookEndpoint", {
          name: formName,
          url: formUrl,
          timeout_ms: formTimeout,
          status: formStatus,
          event_types: formEvents,
          format: formFormat,
          message_template: formTemplate
        });
        revealedSecret = result.secret;
        revealedFor = formName;
      }
      showDialog = false;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      saving = false;
    }
  }

  async function rotate(endpoint: Endpoint) {
    try {
      const result = await call("rotateWebhookEndpointSecret", { id: endpoint.id });
      revealedSecret = result.secret;
      revealedFor = endpoint.name;
      toast.success("Secret rotated. The previous one keeps working for 24 hours.");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rotation failed");
    }
  }

  async function sendTest(endpoint: Endpoint) {
    testing = endpoint.id;
    try {
      const result = await call("testWebhookEndpoint", { id: endpoint.id });
      if (result.ok) toast.success(`Endpoint answered ${result.status}`);
      else toast.error(result.error || `Endpoint answered ${result.status}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      testing = null;
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await call("deleteWebhookEndpoint", { id: deleteTarget.id });
      toast.success("Endpoint deleted. Its delivery history is kept.");
      deleteTarget = null;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function copySecret() {
    if (!revealedSecret) return;
    await navigator.clipboard.writeText(revealedSecret);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  // Timestamps are UTC seconds throughout this codebase.
  const when = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString() : "never");

  const statusVariant = (s: string) =>
    s === "ACTIVE" ? "secondary" : s === "DISABLED_AUTO" ? "destructive" : "outline";

  onMount(load);
</script>

<div class="flex w-full flex-col gap-4 p-4">
  <div class="flex items-center justify-between">
    <p class="text-muted-foreground flex items-center gap-1 text-sm">
      Send a signed HTTP request whenever an incident, maintenance or monitor changes. Every attempt is recorded on the
      <Button variant="link" class="h-auto p-0" href={clientResolver(resolve, "/manage/app/webhooks/deliveries")}>
        delivery log
      </Button>.
    </p>
    <Button onclick={openCreate}>
      <Plus class="h-4 w-4" />
      Add endpoint
    </Button>
  </div>

  {#if revealedSecret}
    <Card.Root class="border-green-600 bg-green-50 dark:bg-green-950/20">
      <Card.Content>
        <div class="flex items-start gap-3">
          <div class="flex-1">
            <p class="font-medium text-green-800 dark:text-green-200">Signing secret for {revealedFor}</p>
            <div class="relative mt-2">
              <code class="bg-background block rounded-md border px-4 py-2 pr-12 font-mono text-sm break-all">
                {revealedSecret}
              </code>
              <Button
                size="icon"
                variant="ghost"
                class="absolute top-1/2 right-2 h-7 w-7 -translate-y-1/2"
                onclick={copySecret}
              >
                {#if copied}<Check class="h-4 w-4 text-green-500" />{:else}<Copy class="h-4 w-4" />{/if}
              </Button>
            </div>
            <p class="text-muted-foreground mt-2 text-xs">
              Copy it now: it is stored encrypted and will
              <strong class="uppercase underline">not be shown again</strong>. Use it to verify the
              <code>Kener-Signature</code> header.
            </p>
          </div>
          <Button size="sm" variant="ghost" onclick={() => (revealedSecret = null)}>Dismiss</Button>
        </div>
      </Card.Content>
    </Card.Root>
  {/if}

  <Card.Root>
    <Card.Content class="p-0">
      {#if loading}
        <div class="flex items-center justify-center py-12"><Spinner class="h-6 w-6" /></div>
      {:else if endpoints.length === 0}
        <div class="text-muted-foreground py-12 text-center">
          <WebhookIcon class="mx-auto mb-4 h-12 w-12 opacity-50" />
          <p>No webhook endpoints yet</p>
          <p class="text-sm">Add one to start receiving incident and maintenance events.</p>
        </div>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head class="pl-4">Name</Table.Head>
              <Table.Head>URL</Table.Head>
              <Table.Head>Events</Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head>Last delivery</Table.Head>
              <Table.Head></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each endpoints as endpoint (endpoint.id)}
              <Table.Row>
                <Table.Cell class="pl-4 font-medium">
                  {endpoint.name}
                  {#if endpoint.secret_hint}
                    <div class="text-muted-foreground font-mono text-xs">{endpoint.secret_hint}</div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="max-w-xs truncate font-mono text-xs">{endpoint.url}</Table.Cell>
                <Table.Cell class="text-xs">
                  {#each endpoint.event_types as t (t)}
                    <Badge variant="outline" class="mr-1 mb-1 font-mono text-[10px]">{t}</Badge>
                  {/each}
                </Table.Cell>
                <Table.Cell>
                  <Badge variant={statusVariant(endpoint.status)}>{endpoint.status}</Badge>
                  {#if endpoint.status === "DISABLED_AUTO"}
                    <div class="text-destructive mt-1 text-xs">
                      Stopped after {endpoint.consecutive_failures} failures
                    </div>
                  {:else if endpoint.consecutive_failures > 0}
                    <div class="text-muted-foreground mt-1 text-xs">
                      {endpoint.consecutive_failures} failing
                    </div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-xs">
                  <div>ok {when(endpoint.last_success_at)}</div>
                  {#if endpoint.last_failure_at}
                    <div class="text-muted-foreground">failed {when(endpoint.last_failure_at)}</div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => sendTest(endpoint)}
                    disabled={testing === endpoint.id}
                  >
                    <SendIcon class="h-4 w-4" />
                    {testing === endpoint.id ? "Sending…" : "Test"}
                  </Button>
                  <Button variant="ghost" size="sm" onclick={() => openEdit(endpoint)}>Edit</Button>
                  <Button variant="ghost" size="sm" onclick={() => rotate(endpoint)}>Rotate secret</Button>
                  <Button variant="ghost" size="sm" onclick={() => (deleteTarget = endpoint)}>
                    <Trash2 class="text-destructive h-4 w-4" />
                  </Button>
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {/if}
    </Card.Content>
  </Card.Root>
</div>

<Dialog.Root bind:open={showDialog}>
  <Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>{editing ? "Edit endpoint" : "Add endpoint"}</Dialog.Title>
      <Dialog.Description>
        {#if editing}
          Changing the URL or the event list takes effect on the next event.
        {:else}
          The signing secret is generated now and shown once.
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1">
        <Label for="wh-name">Name</Label>
        <Input id="wh-name" bind:value={formName} placeholder="Ops Slack bridge" />
      </div>
      <div class="flex flex-col gap-1">
        <Label for="wh-url">URL</Label>
        <Input id="wh-url" bind:value={formUrl} placeholder="https://example.com/hooks/kener" />
        <p class="text-muted-foreground text-xs">
          Private and loopback addresses are refused unless <code>KENER_ALLOW_PRIVATE_WEBHOOKS=true</code>.
        </p>
      </div>
      <div class="flex flex-wrap gap-4">
        <div class="flex flex-col gap-1">
          <Label for="wh-timeout">Timeout (ms)</Label>
          <Input id="wh-timeout" type="number" bind:value={formTimeout} min={1000} max={30000} class="w-40" />
        </div>
        <div class="flex flex-col gap-1">
          <Label for="wh-status">Status</Label>
          <select
            id="wh-status"
            bind:value={formStatus}
            class="border-input bg-background h-9 w-40 rounded-md border px-3 text-sm"
          >
            <option value="ACTIVE">Active</option>
            <option value="DISABLED">Disabled</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <Label for="wh-format">Format</Label>
          <select
            id="wh-format"
            bind:value={formFormat}
            class="border-input bg-background h-9 w-40 rounded-md border px-3 text-sm"
          >
            <option value="GENERIC">Generic JSON</option>
            <option value="DISCORD">Discord</option>
          </select>
        </div>
      </div>

      {#if formFormat === "DISCORD"}
        <div class="flex flex-col gap-2">
          <Label for="wh-template">Message</Label>
          <Textarea
            id="wh-template"
            bind:value={formTemplate}
            rows={3}
            placeholder={PLACEHOLDER_TEMPLATE}
            class="font-mono text-xs"
          />
          <p class="text-muted-foreground text-xs">
            The message posted to the channel. The event detail is added underneath it automatically, so this line is
            just what you want said and who you want told. Leave it empty for the event name alone.
          </p>
          <p class="text-muted-foreground text-xs">
            Variables: <code>{"{{type}}"}</code>, <code>{"{{object.title}}"}</code>,
            <code>{"{{object.status}}"}</code>, <code>{"{{object.severity}}"}</code>,
            <code>{"{{object.monitor_tag}}"}</code>, <code>{"{{site_name}}"}</code>.
          </p>
          <p class="text-muted-foreground text-xs">
            Mention a role with <code>&lt;@&amp;ROLE_ID&gt;</code> or a person with <code>&lt;@USER_ID&gt;</code>. Only
            mentions written here can ping: a mention arriving through a variable is shown but never notifies, so an
            incident title cannot page your whole server.
          </p>
        </div>
      {/if}

      <div class="flex flex-col gap-2">
        <Label>Events</Label>
        <div class="grid gap-4 md:grid-cols-2">
          {#each domains as group (group.domain)}
            <div class="rounded border p-3">
              <label class="flex items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={formEvents.includes(`${group.domain}.*`)}
                  onCheckedChange={(v) => toggleEvent(`${group.domain}.*`, v === true)}
                />
                All {group.domain} events
                <code class="text-muted-foreground text-xs">{group.domain}.*</code>
              </label>
              <div class="mt-2 flex flex-col gap-1 pl-6">
                {#each group.types as type (type)}
                  <label class="text-muted-foreground flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={formEvents.includes(type) || coveredByWildcard(type)}
                      disabled={coveredByWildcard(type)}
                      onCheckedChange={(v) => toggleEvent(type, v === true)}
                    />
                    <code>{type}</code>
                  </label>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (showDialog = false)}>Cancel</Button>
      <Button onclick={save} disabled={saving}>{saving ? "Saving…" : editing ? "Save" : "Create"}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root open={deleteTarget !== null} onOpenChange={(v) => !v && (deleteTarget = null)}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete {deleteTarget?.name}?</AlertDialog.Title>
      <AlertDialog.Description>
        No further events will be sent to this endpoint. Its delivery history is kept, because it is the record of what
        was already sent.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmDelete}>Delete</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
