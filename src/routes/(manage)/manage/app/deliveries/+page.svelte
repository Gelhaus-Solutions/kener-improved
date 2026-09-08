<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import type { EventDeliveryRecord } from "$lib/server/events/types.js";

  // A delivery row plus the event it was delivering, joined server-side.
  type DeliveryRow = EventDeliveryRecord & {
    event_type: string | null;
    occurred_at: number | null;
    aggregate_type: string | null;
    aggregate_id: string | null;
  };

  const PAGE_SIZE = 50;

  let rows = $state<DeliveryRow[]>([]);
  let total = $state(0);
  let consumers = $state<string[]>([]);
  let page = $state(1);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let retrying = $state<number | null>(null);
  let bulkRetrying = $state(false);

  // Filtered server-side, not by narrowing what was already fetched: the log is
  // unbounded and the row someone is looking for is rarely on the first page.
  let filterConsumer = $state("");
  let filterStatus = $state("");
  let filterTarget = $state("");
  let filterEventId = $state("");

  let expanded = $state<number | null>(null);
  let totalPages = $derived(Math.max(1, Math.ceil(total / PAGE_SIZE)));

  // Offering "retry all" only makes sense when the filters name one target.
  let bulkTarget = $derived(
    filterTarget && filterConsumer ? { consumer: filterConsumer, target_id: filterTarget } : null
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

  async function load() {
    loading = true;
    error = null;
    try {
      const body = await call("getEventDeliveries", {
        page,
        limit: PAGE_SIZE,
        consumer: filterConsumer || undefined,
        status: filterStatus || undefined,
        target_id: filterTarget || undefined,
        event_id: filterEventId || undefined
      });
      rows = body.deliveries ?? [];
      total = body.total ?? 0;
      consumers = body.consumers ?? [];
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load the delivery log";
    } finally {
      loading = false;
    }
  }

  async function retry(id: number) {
    retrying = id;
    notice = null;
    try {
      await call("retryEventDelivery", { id });
      notice = `Delivery ${id} has been queued for another attempt.`;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Retry failed";
    } finally {
      retrying = null;
    }
  }

  async function retryAll() {
    if (!bulkTarget) return;
    bulkRetrying = true;
    notice = null;
    try {
      const body = await call("retryDeliveriesForTarget", {
        consumer: bulkTarget.consumer,
        // The target type is not a filter, so it is taken from a row already on
        // screen: every delivery to one target shares it.
        target_type: rows.find((r) => r.target_id === bulkTarget!.target_id)?.target_type ?? "endpoint",
        target_id: bulkTarget.target_id
      });
      notice = `Queued ${body.retried} of ${body.found} dead deliveries.${body.capped ? " More remain; run it again." : ""}`;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Bulk retry failed";
    } finally {
      bulkRetrying = false;
    }
  }

  function applyFilters() {
    page = 1;
    load();
  }

  function go(delta: number) {
    const next = page + delta;
    if (next < 1 || next > totalPages) return;
    page = next;
    load();
  }

  // Timestamps are UTC seconds throughout this codebase.
  const when = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString() : "-");

  const statusVariant = (status: string) =>
    status === "DELIVERED"
      ? "secondary"
      : status === "DEAD"
        ? "destructive"
        : status === "FAILED"
          ? "destructive"
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

  onMount(load);
</script>

<div class="flex flex-col gap-4 p-4">
  <Card.Root>
    <Card.Header>
      <Card.Title>Delivery log</Card.Title>
      <Card.Description>
        Every outbound attempt Kener has made: webhooks and subscriber email alike. A delivery that exhausted its retry
        ladder is marked DEAD and can be sent again from here.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex flex-col gap-1">
          <Label for="f-consumer">Channel</Label>
          <select
            id="f-consumer"
            bind:value={filterConsumer}
            class="border-input bg-background h-9 w-44 rounded-md border px-3 text-sm"
          >
            <option value="">All channels</option>
            {#each consumers as c (c)}
              <option value={c}>{c}</option>
            {/each}
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <Label for="f-status">Status</Label>
          <select
            id="f-status"
            bind:value={filterStatus}
            class="border-input bg-background h-9 w-44 rounded-md border px-3 text-sm"
          >
            <option value="">Any status</option>
            {#each ["PENDING", "IN_FLIGHT", "DELIVERED", "FAILED", "DEAD", "SKIPPED", "SHADOW"] as s (s)}
              <option value={s}>{s}</option>
            {/each}
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <Label for="f-target">Target id</Label>
          <Input id="f-target" bind:value={filterTarget} placeholder="endpoint id" class="w-40" />
        </div>
        <div class="flex flex-col gap-1">
          <Label for="f-event">Event id</Label>
          <Input id="f-event" bind:value={filterEventId} placeholder="01J…" class="w-56" />
        </div>
        <Button onclick={applyFilters} disabled={loading}>Filter</Button>
        {#if bulkTarget}
          <Button variant="outline" onclick={retryAll} disabled={bulkRetrying}>
            {bulkRetrying ? "Retrying…" : "Retry all dead for this target"}
          </Button>
        {/if}
      </div>
    </Card.Content>
  </Card.Root>

  {#if notice}
    <div class="bg-muted/40 rounded p-3 text-sm">{notice}</div>
  {/if}

  {#if loading}
    <div class="flex justify-center p-8"><Spinner /></div>
  {:else if error}
    <div class="text-destructive p-4 text-sm">{error}</div>
  {:else if rows.length === 0}
    <div class="text-muted-foreground p-8 text-center text-sm">No deliveries match these filters.</div>
  {:else}
    <div class="overflow-x-auto rounded border">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>When</Table.Head>
            <Table.Head>Event</Table.Head>
            <Table.Head>Channel</Table.Head>
            <Table.Head>Target</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Attempts</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each rows as row (row.id)}
            <Table.Row>
              <Table.Cell class="text-xs whitespace-nowrap">{when(row.created_at)}</Table.Cell>
              <Table.Cell class="font-mono text-xs">
                {row.event_type ?? "-"}
                {#if row.aggregate_id}
                  <span class="text-muted-foreground">{row.aggregate_type} {row.aggregate_id}</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="text-xs">{row.consumer}</Table.Cell>
              <Table.Cell class="text-xs">
                {row.target_type || "-"}
                {#if row.target_id}<span class="text-muted-foreground"> {row.target_id}</span>{/if}
              </Table.Cell>
              <Table.Cell><Badge variant={statusVariant(row.status)}>{row.status}</Badge></Table.Cell>
              <Table.Cell class="text-xs">
                {row.attempts}
                {#if row.next_attempt_at && row.status === "FAILED"}
                  <span class="text-muted-foreground">next {when(row.next_attempt_at)}</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="whitespace-nowrap">
                <Button variant="ghost" size="sm" onclick={() => (expanded = expanded === row.id ? null : row.id)}>
                  {expanded === row.id ? "Hide" : "Details"}
                </Button>
                {#if row.status === "DEAD"}
                  <Button variant="outline" size="sm" onclick={() => retry(row.id)} disabled={retrying === row.id}>
                    {retrying === row.id ? "…" : "Retry"}
                  </Button>
                {/if}
              </Table.Cell>
            </Table.Row>
            {#if expanded === row.id}
              <Table.Row>
                <Table.Cell colspan={7}>
                  <div class="bg-muted/40 grid gap-3 rounded p-3 text-xs md:grid-cols-2">
                    {#if row.error}
                      <div class="text-destructive md:col-span-2">
                        <div class="mb-1 font-semibold">Error</div>
                        <pre class="overflow-x-auto whitespace-pre-wrap">{row.error}</pre>
                      </div>
                    {/if}
                    {#if row.request_headers}
                      <div>
                        <div class="mb-1 font-semibold">Request headers</div>
                        <pre class="overflow-x-auto whitespace-pre-wrap">{pretty(row.request_headers)}</pre>
                      </div>
                    {/if}
                    {#if row.response_body}
                      <div>
                        <div class="mb-1 font-semibold">Response body</div>
                        <pre class="overflow-x-auto whitespace-pre-wrap">{row.response_body}</pre>
                      </div>
                    {/if}
                    {#if row.request_body}
                      <div class="md:col-span-2">
                        <div class="mb-1 font-semibold">Request body</div>
                        <pre class="max-h-80 overflow-auto whitespace-pre-wrap">{pretty(row.request_body)}</pre>
                      </div>
                    {/if}
                    <div class="text-muted-foreground md:col-span-2">
                      event {row.event_id} &middot; response {row.response_code ?? "-"} &middot;
                      {row.duration_ms !== null && row.duration_ms !== undefined ? `${row.duration_ms}ms` : "no timing"}
                      &middot; last attempt {when(row.last_attempt_at)}
                    </div>
                  </div>
                </Table.Cell>
              </Table.Row>
            {/if}
          {/each}
        </Table.Body>
      </Table.Root>
    </div>

    <div class="flex items-center justify-between text-sm">
      <span class="text-muted-foreground">{total} deliveries</span>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" onclick={() => go(-1)} disabled={page <= 1}>Previous</Button>
        <span class="text-muted-foreground">Page {page} of {totalPages}</span>
        <Button variant="outline" size="sm" onclick={() => go(1)} disabled={page >= totalPages}>Next</Button>
      </div>
    </div>
  {/if}
</div>
