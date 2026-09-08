<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import type { ConsumerMode } from "$lib/server/events/types.js";
  import type { DiffRow, DiffVerdict } from "$lib/server/events/shadowDiff.js";

  interface ConsumerRow {
    name: string;
    description: string;
    declared_mode: ConsumerMode;
    configured_mode: ConsumerMode | null;
    effective_mode: ConsumerMode;
    supports_dry_run: boolean;
    ordered: boolean;
    legacy_consumer: string | null;
    counts: Record<string, number>;
  }

  const PAGE_SIZE = 25;

  const MODES: ConsumerMode[] = ["off", "legacy", "shadow", "live"];

  // Written out rather than left to the mode name alone. "shadow" and "legacy"
  // both mean "nothing is sent", and an operator deciding whether it is safe to
  // move a consumer should not have to hold the difference in their head.
  const MODE_HELP: Record<ConsumerMode, string> = {
    off: "Ignored entirely. No record of what it would have done.",
    legacy: "Records who would have been notified. Sends nothing; the existing path still does the work.",
    shadow: "Works out the full message and records it. Sends nothing; the existing path still does the work.",
    live: "Sends for real."
  };

  const VERDICT_HELP: Record<DiffVerdict, string> = {
    MATCH: "The rehearsal and the real send agree.",
    BODY_DIFFERS: "Both sent to this recipient, but the message differs.",
    PRESENCE_ONLY: "Both sent to this recipient. The existing path stores no message body to compare.",
    MISSING_LIVE: "The rehearsal would have notified someone the existing path did not.",
    MISSING_SHADOW:
      "The existing path notified someone the rehearsal would have missed. This one would lose a message.",
    SHADOW_ERROR: "The rehearsal could not work out what to send."
  };

  let consumers = $state<ConsumerRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let saving = $state<string | null>(null);

  let pairs = $state<string[]>([]);
  let diffConsumer = $state("subscribers");
  let diffRows = $state<DiffRow[]>([]);
  let diffSummary = $state<Record<string, number>>({});
  let diffTotal = $state(0);
  let diffPage = $state(1);
  let diffLoading = $state(false);
  let blockingOnly = $state(false);
  let expanded = $state<string | null>(null);

  let diffPages = $derived(Math.max(1, Math.ceil(diffTotal / PAGE_SIZE)));

  // The single number this screen exists to produce. While it is above zero the
  // consumer is not safe to turn live, because each one is a notification a real
  // subscriber would stop receiving.
  let blockingCount = $derived(
    (diffSummary.MISSING_SHADOW ?? 0) + (diffSummary.SHADOW_ERROR ?? 0) + (diffSummary.BODY_DIFFERS ?? 0)
  );

  async function call(action: string, data: Record<string, unknown>) {
    const res = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || "Request failed");
    return body;
  }

  async function loadConsumers() {
    loading = true;
    error = null;
    try {
      const body = await call("getEventConsumers", {});
      consumers = body.consumers ?? [];
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load the event bus consumers";
    } finally {
      loading = false;
    }
  }

  async function loadDiff() {
    diffLoading = true;
    error = null;
    try {
      const body = await call("getShadowDiff", {
        consumer: diffConsumer,
        page: diffPage,
        limit: PAGE_SIZE,
        blocking_only: blockingOnly
      });
      diffRows = body.rows ?? [];
      diffSummary = body.summary ?? {};
      diffTotal = body.total ?? 0;
      pairs = body.pairs ?? [];
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load the shadow diff";
    } finally {
      diffLoading = false;
    }
  }

  async function setMode(name: string, mode: ConsumerMode) {
    saving = name;
    notice = null;
    error = null;
    try {
      await call("setEventConsumerMode", { name, mode });
      notice = `"${name}" is now ${mode}. The delivery process picks this up within ten seconds.`;
      await loadConsumers();
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not change the mode";
      // Reload regardless, so a rejected change does not leave the select
      // showing a value that was never saved.
      await loadConsumers();
    } finally {
      saving = null;
    }
  }

  function changeDiffConsumer(next: string) {
    diffConsumer = next;
    diffPage = 1;
    loadDiff();
  }

  function goDiff(delta: number) {
    const next = diffPage + delta;
    if (next < 1 || next > diffPages) return;
    diffPage = next;
    loadDiff();
  }

  // Timestamps are UTC seconds throughout this codebase.
  const when = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString() : "-");

  const modeVariant = (mode: ConsumerMode) => (mode === "live" ? "default" : mode === "off" ? "outline" : "secondary");

  const verdictVariant = (verdict: DiffVerdict) =>
    verdict === "MISSING_SHADOW" || verdict === "SHADOW_ERROR"
      ? "destructive"
      : verdict === "BODY_DIFFERS"
        ? "destructive"
        : verdict === "MATCH"
          ? "secondary"
          : "outline";

  // Pretty-printed when it parses, raw when it does not: a body that is not JSON
  // is exactly the case someone is debugging.
  function pretty(value: string | null | undefined): string {
    if (!value) return "";
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  const rowKey = (row: DiffRow) => `${row.event_id}:${row.target_type}:${row.target_id}`;

  onMount(async () => {
    await loadConsumers();
    await loadDiff();
  });
</script>

<div class="flex flex-col gap-4 p-4">
  <Card.Root>
    <Card.Header>
      <Card.Title>Event bus consumers</Card.Title>
      <Card.Description>
        Everything Kener sends is driven by an internal event bus, and each consumer below turns those events into one
        kind of outbound message. Changing a mode takes effect within ten seconds and needs no restart, so a consumer
        that misbehaves can be pulled back immediately.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      {#if notice}
        <p class="mb-3 text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>
      {/if}
      {#if error}
        <p class="text-destructive mb-3 text-sm">{error}</p>
      {/if}

      {#if loading}
        <div class="flex justify-center p-6"><Spinner /></div>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Consumer</Table.Head>
              <Table.Head>Mode</Table.Head>
              <Table.Head>Deliveries</Table.Head>
              <Table.Head class="w-56">Change to</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each consumers as consumer (consumer.name)}
              <Table.Row>
                <Table.Cell class="align-top">
                  <div class="font-medium">{consumer.name}</div>
                  <div class="text-muted-foreground max-w-md text-xs">{consumer.description}</div>
                  {#if consumer.legacy_consumer}
                    <div class="text-muted-foreground mt-1 text-xs">
                      Compared against <span class="font-mono">{consumer.legacy_consumer}</span>
                    </div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="align-top">
                  <Badge variant={modeVariant(consumer.effective_mode)}>{consumer.effective_mode}</Badge>
                  <div class="text-muted-foreground mt-1 max-w-xs text-xs">
                    {MODE_HELP[consumer.effective_mode]}
                  </div>
                  {#if consumer.configured_mode === null}
                    <div class="text-muted-foreground mt-1 text-xs">Not configured; using the built-in default.</div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="align-top">
                  {#if Object.keys(consumer.counts).length === 0}
                    <span class="text-muted-foreground text-xs">None yet</span>
                  {:else}
                    <div class="flex flex-wrap gap-1">
                      {#each Object.entries(consumer.counts) as [status, count] (status)}
                        <Badge variant="outline" class="text-xs">{status} {count}</Badge>
                      {/each}
                    </div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="align-top">
                  <select
                    class="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                    value={consumer.effective_mode}
                    disabled={saving === consumer.name}
                    onchange={(e) => setMode(consumer.name, e.currentTarget.value as ConsumerMode)}
                  >
                    {#each MODES as mode (mode)}
                      <option value={mode}>{mode}</option>
                    {/each}
                  </select>
                  {#if consumer.declared_mode === "shadow"}
                    <div class="text-muted-foreground mt-1 text-xs">
                      Cannot be set live here: the existing send path is still running, so every message would go twice.
                    </div>
                  {/if}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Shadow diff</Card.Title>
      <Card.Description>
        What a rehearsing consumer would have sent, against what was actually sent. Only one finding is a reason to
        stop: <strong>MISSING_SHADOW</strong> means the existing path notified somebody the new path would not have, so moving
        over would silently drop that message.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <div class="mb-4 flex flex-wrap items-end gap-3">
        <div class="flex flex-col gap-1">
          <Label for="d-consumer">Consumer</Label>
          <select
            id="d-consumer"
            class="border-input bg-background h-9 w-48 rounded-md border px-3 text-sm"
            value={diffConsumer}
            onchange={(e) => changeDiffConsumer(e.currentTarget.value)}
          >
            {#each pairs.length ? pairs : [diffConsumer] as name (name)}
              <option value={name}>{name}</option>
            {/each}
          </select>
        </div>
        <label class="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={blockingOnly}
            onchange={(e) => {
              blockingOnly = e.currentTarget.checked;
              diffPage = 1;
              loadDiff();
            }}
          />
          Only show findings that would block a move
        </label>
        <Button variant="outline" onclick={() => loadDiff()} disabled={diffLoading}>Refresh</Button>
      </div>

      {#if Object.keys(diffSummary).length > 0}
        <div class="mb-4 flex flex-wrap gap-2">
          {#each Object.entries(diffSummary) as [verdict, count] (verdict)}
            <Badge variant={verdictVariant(verdict as DiffVerdict)}>{verdict} {count}</Badge>
          {/each}
        </div>
        <p class="mb-4 text-sm">
          {#if blockingCount === 0}
            <span class="text-emerald-600 dark:text-emerald-400">
              Nothing on this page would block a move to live.
            </span>
          {:else}
            <span class="text-destructive">
              {blockingCount} finding{blockingCount === 1 ? "" : "s"} on this page would block a move to live.
            </span>
          {/if}
          <span class="text-muted-foreground"> The counts cover this page of events only, not the whole history. </span>
        </p>
      {/if}

      {#if diffLoading}
        <div class="flex justify-center p-6"><Spinner /></div>
      {:else if diffRows.length === 0}
        <p class="text-muted-foreground p-6 text-center text-sm">
          Nothing to compare yet. Rows appear here once an incident comment, a maintenance change or an alert has
          happened while this consumer was rehearsing.
        </p>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>When</Table.Head>
              <Table.Head>Event</Table.Head>
              <Table.Head>Recipient</Table.Head>
              <Table.Head>Verdict</Table.Head>
              <Table.Head></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each diffRows as row (rowKey(row))}
              <Table.Row>
                <Table.Cell class="text-xs whitespace-nowrap">{when(row.occurred_at)}</Table.Cell>
                <Table.Cell class="text-xs">
                  <div>{row.event_type ?? "-"}</div>
                  <div class="text-muted-foreground font-mono">{row.event_id}</div>
                </Table.Cell>
                <Table.Cell class="text-xs">
                  <span class="font-mono">{row.target_type} {row.target_id}</span>
                </Table.Cell>
                <Table.Cell>
                  <Badge variant={verdictVariant(row.verdict)}>{row.verdict}</Badge>
                  <div class="text-muted-foreground mt-1 max-w-xs text-xs">{VERDICT_HELP[row.verdict]}</div>
                  {#if row.differing_fields.length > 0}
                    <div class="text-muted-foreground mt-1 max-w-xs text-xs">
                      Differs in: {row.differing_fields.join(", ")}
                    </div>
                  {/if}
                </Table.Cell>
                <Table.Cell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => (expanded = expanded === rowKey(row) ? null : rowKey(row))}
                  >
                    {expanded === rowKey(row) ? "Hide" : "Compare"}
                  </Button>
                </Table.Cell>
              </Table.Row>
              {#if expanded === rowKey(row)}
                <Table.Row>
                  <Table.Cell colspan={5}>
                    <div class="grid gap-4 md:grid-cols-2">
                      <div>
                        <div class="mb-1 text-xs font-medium">Rehearsal ({row.consumer})</div>
                        {#if row.shadow_error}
                          <p class="text-destructive text-xs">{row.shadow_error}</p>
                        {/if}
                        <pre class="bg-muted max-h-80 overflow-auto rounded p-2 text-xs">{pretty(row.shadow_body) ||
                            "No message recorded."}</pre>
                      </div>
                      <div>
                        <div class="mb-1 text-xs font-medium">Actually sent ({row.legacy_consumer})</div>
                        {#if row.live_error}
                          <p class="text-destructive text-xs">{row.live_error}</p>
                        {/if}
                        <pre class="bg-muted max-h-80 overflow-auto rounded p-2 text-xs">{pretty(row.live_body) ||
                            "No message recorded."}</pre>
                      </div>
                    </div>
                  </Table.Cell>
                </Table.Row>
              {/if}
            {/each}
          </Table.Body>
        </Table.Root>

        <div class="mt-4 flex items-center justify-between">
          <span class="text-muted-foreground text-sm">
            Page {diffPage} of {diffPages} ({diffTotal} event{diffTotal === 1 ? "" : "s"})
          </span>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" onclick={() => goDiff(-1)} disabled={diffPage <= 1 || diffLoading}>
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onclick={() => goDiff(1)}
              disabled={diffPage >= diffPages || diffLoading}
            >
              Next
            </Button>
          </div>
        </div>
      {/if}
    </Card.Content>
  </Card.Root>
</div>
