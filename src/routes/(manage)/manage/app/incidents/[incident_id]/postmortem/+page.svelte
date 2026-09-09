<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Breadcrumb from "$lib/components/ui/breadcrumb/index.js";
  import SaveIcon from "@lucide/svelte/icons/save";
  import Loader from "@lucide/svelte/icons/loader";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import TrashIcon from "@lucide/svelte/icons/trash";
  import SendIcon from "@lucide/svelte/icons/send";
  import EyeOffIcon from "@lucide/svelte/icons/eye-off";
  import ArchiveIcon from "@lucide/svelte/icons/archive";
  import type { PageProps } from "./$types";
  import { toast } from "svelte-sonner";
  import { mode } from "mode-watcher";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import CodeMirror from "svelte-codemirror-editor";
  import { markdown } from "@codemirror/lang-markdown";
  import { githubLight, githubDark } from "@uiw/codemirror-theme-github";
  import type {
    Postmortem,
    PostmortemActionItem,
    PostmortemTimelineEntry
  } from "$lib/server/types/postmortem.js";

  let { params }: PageProps = $props();
  const incidentId = $derived(parseInt(params.incident_id));

  let loading = $state(true);
  let saving = $state(false);
  let publishing = $state(false);
  let error = $state<string | null>(null);

  // Null until the first save: a postmortem is created lazily, so opening this
  // page on an incident that has none must not write a row. Somebody looking is
  // not somebody drafting.
  let postmortem = $state<Postmortem | null>(null);
  let incidentTitle = $state("");

  let title = $state("");
  let summary = $state("");
  let rootCause = $state("");
  let impactDescription = $state("");
  let resolution = $state("");
  let bodyMd = $state("");
  let timelineSource = $state<"COMMENTS" | "CUSTOM">("COMMENTS");
  let notifySubscribers = $state(false);
  let actionItems = $state<PostmortemActionItem[]>([]);
  let timelineEntries = $state<PostmortemTimelineEntry[]>([]);

  const ACTION_STATUSES: Array<{ value: PostmortemActionItem["status"]; label: string }> = [
    { value: "OPEN", label: "Open" },
    { value: "IN_PROGRESS", label: "In Progress" },
    { value: "DONE", label: "Done" },
    { value: "CANCELLED", label: "Cancelled" }
  ];
  const actionStatusLabel = (v: string) => ACTION_STATUSES.find((s) => s.value === v)?.label ?? "Open";

  const isPublished = $derived(postmortem?.status === "PUBLISHED");
  const canPublish = $derived(postmortem !== null && !isPublished);

  function timestampToLocalDatetime(ts: number): string {
    const date = new Date(ts * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function localDatetimeToTimestamp(value: string): number {
    if (!value) return Math.floor(Date.now() / 1000);
    return Math.floor(new Date(value).getTime() / 1000);
  }

  async function call(action: string, data: unknown) {
    const response = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    return await response.json();
  }

  function applyRecord(record: Postmortem | null) {
    postmortem = record;
    if (!record) return;
    title = record.title;
    summary = record.summary ?? "";
    rootCause = record.root_cause ?? "";
    impactDescription = record.impact_description ?? "";
    resolution = record.resolution ?? "";
    bodyMd = record.body_md ?? "";
    timelineSource = record.timeline_source === "CUSTOM" ? "CUSTOM" : "COMMENTS";
    notifySubscribers = record.notify_subscribers === "YES";
    actionItems = record.action_items;
    timelineEntries = record.timeline_custom;
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const [incident, record] = await Promise.all([
        call("getIncident", { incident_id: incidentId }),
        call("getPostmortem", { incident_id: incidentId })
      ]);
      if (incident?.error) {
        error = incident.error;
        return;
      }
      incidentTitle = incident?.title ?? "";
      if (record?.error) {
        error = record.error;
        return;
      }
      applyRecord(record ?? null);
      // A postmortem with no title of its own is still about a thing that has
      // one, so the incident's title is what an author starts from.
      if (!record) title = incident?.title ?? "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load the postmortem";
    } finally {
      loading = false;
    }
  }

  async function save() {
    saving = true;
    try {
      const result = await call("savePostmortem", {
        incident_id: incidentId,
        title,
        summary,
        root_cause: rootCause,
        impact_description: impactDescription,
        resolution,
        body_md: bodyMd,
        timeline_source: timelineSource,
        timeline_custom: timelineEntries,
        action_items: actionItems,
        notify_subscribers: notifySubscribers ? "YES" : "NO"
      });
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      applyRecord(result);
      toast.success("Postmortem saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save the postmortem");
    } finally {
      saving = false;
    }
  }

  /**
   * Saves first, then publishes.
   *
   * Two calls rather than one, because publishing is its own action with its own
   * event and nothing may make a document public as a side effect of a save. But
   * an author who edits and then hits Publish means "publish what is on my
   * screen", so the save has to happen first or they would publish the version
   * before their last edit.
   */
  async function publish() {
    publishing = true;
    try {
      await save();
      const result = await call("publishPostmortem", { incident_id: incidentId });
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      applyRecord(result);
      toast.success(notifySubscribers ? "Published, and subscribers notified" : "Published");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to publish");
    } finally {
      publishing = false;
    }
  }

  async function unpublish(archive: boolean) {
    publishing = true;
    try {
      const result = await call("unpublishPostmortem", { incident_id: incidentId, archive });
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      applyRecord(result);
      toast.success(archive ? "Archived" : "Returned to draft");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to withdraw the postmortem");
    } finally {
      publishing = false;
    }
  }

  function addActionItem() {
    actionItems = [...actionItems, { text: "", owner: null, due_at: null, status: "OPEN" }];
  }

  function removeActionItem(index: number) {
    actionItems = actionItems.filter((_, i) => i !== index);
  }

  function addTimelineEntry() {
    const last = timelineEntries.length > 0 ? timelineEntries[timelineEntries.length - 1].at : null;
    // A minute after the previous entry, so adding several in a row produces a
    // timeline that is already in order and already distinct rather than several
    // entries stamped identically.
    timelineEntries = [...timelineEntries, { at: last !== null ? last + 60 : Math.floor(Date.now() / 1000), text: "" }];
  }

  function removeTimelineEntry(index: number) {
    timelineEntries = timelineEntries.filter((_, i) => i !== index);
  }

  function sortTimeline() {
    timelineEntries = [...timelineEntries].sort((a, b) => a.at - b.at);
  }

  $effect(() => {
    if (Number.isInteger(incidentId) && incidentId > 0) void load();
  });
</script>

<div class="flex flex-col gap-4 p-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <Breadcrumb.Root>
      <Breadcrumb.List>
        <Breadcrumb.Item>
          <Breadcrumb.Link href={clientResolver(resolve, "/manage/app/incidents")}>Incidents</Breadcrumb.Link>
        </Breadcrumb.Item>
        <Breadcrumb.Separator />
        <Breadcrumb.Item>
          <Breadcrumb.Link href={clientResolver(resolve, `/manage/app/incidents/${params.incident_id}`)}>
            {incidentTitle || `Incident #${params.incident_id}`}
          </Breadcrumb.Link>
        </Breadcrumb.Item>
        <Breadcrumb.Separator />
        <Breadcrumb.Item>
          <Breadcrumb.Page>Postmortem</Breadcrumb.Page>
        </Breadcrumb.Item>
      </Breadcrumb.List>
    </Breadcrumb.Root>

    {#if postmortem}
      <Badge variant={isPublished ? "default" : "secondary"}>{postmortem.status}</Badge>
    {/if}
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><Spinner /></div>
  {:else if error}
    <Card.Root class="border-destructive">
      <Card.Content class="pt-6">
        <p class="text-destructive">{error}</p>
      </Card.Content>
    </Card.Root>
  {:else}
    <Card.Root>
      <Card.Header>
        <Card.Title>Postmortem</Card.Title>
        <Card.Description>
          The account of this incident, drafted after it closed and published separately from the live updates. Nothing
          here reaches a customer until you publish it.
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-6">
        <div class="space-y-2">
          <Label for="pm-title">Title</Label>
          <Input id="pm-title" bind:value={title} placeholder="What happened, in a line" />
        </div>

        {#each [{ id: "pm-summary", label: "Summary", hint: "The short version, and what a subscriber sees in the notification email.", get: () => summary, set: (v: string) => (summary = v) }, { id: "pm-root-cause", label: "Root cause", hint: "What actually caused it.", get: () => rootCause, set: (v: string) => (rootCause = v) }, { id: "pm-impact", label: "Impact", hint: "Who was affected, how, and for how long.", get: () => impactDescription, set: (v: string) => (impactDescription = v) }, { id: "pm-resolution", label: "Resolution", hint: "What fixed it.", get: () => resolution, set: (v: string) => (resolution = v) }] as field (field.id)}
          <div class="space-y-2">
            <Label for={field.id}>{field.label}</Label>
            <Textarea
              id={field.id}
              rows={3}
              value={field.get()}
              oninput={(e) => field.set((e.currentTarget as HTMLTextAreaElement).value)}
            />
            <p class="text-muted-foreground text-xs">{field.hint}</p>
          </div>
        {/each}

        <div class="space-y-2">
          <Label>Full write-up</Label>
          <div class="overflow-hidden rounded-md border">
            <CodeMirror
              bind:value={bodyMd}
              lang={markdown()}
              theme={mode.current === "dark" ? githubDark : githubLight}
              styles={{ "&": { minHeight: "280px" } }}
            />
          </div>
          <p class="text-muted-foreground text-xs">
            Markdown, rendered through the same pipeline as incident updates.
          </p>
        </div>
      </Card.Content>
    </Card.Root>

    <!-- Timeline -->
    <Card.Root>
      <Card.Header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Card.Title>Timeline</Card.Title>
            <Card.Description>
              What the published document shows as the sequence of events.
            </Card.Description>
          </div>
          {#if timelineSource === "CUSTOM"}
            <div class="flex gap-2">
              <Button size="sm" variant="outline" onclick={sortTimeline}>Sort by time</Button>
              <Button size="sm" onclick={addTimelineEntry}>
                <PlusIcon class="size-4" />
                Add entry
              </Button>
            </div>
          {/if}
        </div>
      </Card.Header>
      <Card.Content class="space-y-4">
        <div class="space-y-2">
          <Label>Source</Label>
          <Select.Root
            type="single"
            value={timelineSource}
            onValueChange={(v) => {
              if (v === "COMMENTS" || v === "CUSTOM") timelineSource = v;
            }}
          >
            <Select.Trigger class="w-full">
              {timelineSource === "CUSTOM" ? "Written for the postmortem" : "The incident's own updates"}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="COMMENTS">The incident's own updates</Select.Item>
              <Select.Item value="CUSTOM">Written for the postmortem</Select.Item>
            </Select.Content>
          </Select.Root>
          <p class="text-muted-foreground text-xs">
            The live updates are written under pressure and are often not the account you want to publish a week later.
            Choosing to write one leaves the incident's own timeline untouched.
          </p>
        </div>

        {#if timelineSource === "CUSTOM"}
          {#if timelineEntries.length === 0}
            <p class="text-muted-foreground text-sm">
              No entries yet. Until you add some, the published postmortem shows no timeline at all.
            </p>
          {:else}
            <div class="space-y-3">
              {#each timelineEntries as entry, i (i)}
                <div class="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start">
                  <Input
                    type="datetime-local"
                    class="sm:w-56"
                    value={timestampToLocalDatetime(entry.at)}
                    onchange={(e) => {
                      timelineEntries[i].at = localDatetimeToTimestamp((e.currentTarget as HTMLInputElement).value);
                    }}
                  />
                  <Textarea
                    rows={2}
                    class="flex-1"
                    placeholder="What happened at this point"
                    value={entry.text}
                    oninput={(e) => {
                      timelineEntries[i].text = (e.currentTarget as HTMLTextAreaElement).value;
                    }}
                  />
                  <Button variant="ghost" size="icon" onclick={() => removeTimelineEntry(i)}>
                    <TrashIcon class="size-4" />
                  </Button>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </Card.Content>
    </Card.Root>

    <!-- Action items -->
    <Card.Root>
      <Card.Header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Card.Title>Follow-up actions</Card.Title>
            <Card.Description>What you have committed to doing so this does not happen again.</Card.Description>
          </div>
          <Button size="sm" onclick={addActionItem}>
            <PlusIcon class="size-4" />
            Add action
          </Button>
        </div>
      </Card.Header>
      <Card.Content>
        {#if actionItems.length === 0}
          <p class="text-muted-foreground text-sm">No follow-up actions recorded.</p>
        {:else}
          <div class="space-y-3">
            {#each actionItems as item, i (i)}
              <div class="space-y-2 rounded-md border p-3">
                <Textarea
                  rows={2}
                  placeholder="What will be done"
                  value={item.text}
                  oninput={(e) => {
                    actionItems[i].text = (e.currentTarget as HTMLTextAreaElement).value;
                  }}
                />
                <div class="grid gap-2 sm:grid-cols-4">
                  <Input
                    placeholder="Owner (a person or a team)"
                    class="sm:col-span-2"
                    value={item.owner ?? ""}
                    oninput={(e) => {
                      const v = (e.currentTarget as HTMLInputElement).value.trim();
                      actionItems[i].owner = v === "" ? null : v;
                    }}
                  />
                  <Input
                    type="date"
                    value={item.due_at ? timestampToLocalDatetime(item.due_at).slice(0, 10) : ""}
                    onchange={(e) => {
                      const v = (e.currentTarget as HTMLInputElement).value;
                      actionItems[i].due_at = v === "" ? null : Math.floor(new Date(v).getTime() / 1000);
                    }}
                  />
                  <div class="flex gap-2">
                    <Select.Root
                      type="single"
                      value={item.status}
                      onValueChange={(v) => {
                        if (v) actionItems[i].status = v as PostmortemActionItem["status"];
                      }}
                    >
                      <Select.Trigger class="w-full">{actionStatusLabel(item.status)}</Select.Trigger>
                      <Select.Content>
                        {#each ACTION_STATUSES as status (status.value)}
                          <Select.Item value={status.value}>{status.label}</Select.Item>
                        {/each}
                      </Select.Content>
                    </Select.Root>
                    <Button variant="ghost" size="icon" onclick={() => removeActionItem(i)}>
                      <TrashIcon class="size-4" />
                    </Button>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </Card.Content>
    </Card.Root>

    <!-- Publication -->
    <Card.Root>
      <Card.Header>
        <Card.Title>Publication</Card.Title>
        <Card.Description>
          A published postmortem appears on the incident's public page and in the RSS feed.
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <Label for="pm-notify">Notify subscribers on publish</Label>
            <p class="text-muted-foreground text-xs">
              Off by default. Worth turning on for the write-up of an outage people felt, and not worth it for a
              ten-minute blip.
            </p>
          </div>
          <Switch id="pm-notify" bind:checked={notifySubscribers} />
        </div>

        {#if postmortem?.published_at}
          <p class="text-muted-foreground text-xs">
            First published {new Date(postmortem.published_at * 1000).toLocaleString()}. Withdrawing it does not clear
            that date.
          </p>
        {/if}
      </Card.Content>
      <Card.Footer class="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onclick={save} disabled={saving || publishing}>
          {#if saving}
            <Loader class="size-4 animate-spin" />
          {:else}
            <SaveIcon class="size-4" />
          {/if}
          Save draft
        </Button>

        {#if isPublished}
          <Button variant="outline" onclick={() => unpublish(false)} disabled={publishing}>
            <EyeOffIcon class="size-4" />
            Return to draft
          </Button>
          <Button variant="outline" onclick={() => unpublish(true)} disabled={publishing}>
            <ArchiveIcon class="size-4" />
            Archive
          </Button>
        {:else}
          <Button onclick={publish} disabled={publishing || saving || (!canPublish && !postmortem)}>
            {#if publishing}
              <Loader class="size-4 animate-spin" />
            {:else}
              <SendIcon class="size-4" />
            {/if}
            Publish
          </Button>
        {/if}
      </Card.Footer>
    </Card.Root>
  {/if}
</div>
