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
  import type { AuditLogRecord } from "$lib/server/types/db.js";

  const PAGE_SIZE = 50;

  let rows = $state<AuditLogRecord[]>([]);
  let total = $state(0);
  let page = $state(1);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Filters are applied server-side, not by narrowing what was already fetched:
  // the log is unbounded and the interesting row is rarely on the first page.
  let filterAction = $state("");
  let filterActor = $state("");
  let filterOutcome = $state("");

  let expanded = $state<number | null>(null);
  let totalPages = $derived(Math.max(1, Math.ceil(total / PAGE_SIZE)));

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await fetch(clientResolver(resolve, "/manage/api"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "getAuditLog",
          data: {
            page,
            limit: PAGE_SIZE,
            filter: {
              action: filterAction || undefined,
              actor_id: filterActor || undefined,
              outcome: filterOutcome || undefined
            }
          }
        })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Failed to load the audit log");
      rows = body.rows ?? [];
      total = body.total ?? 0;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load the audit log";
    } finally {
      loading = false;
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
  const when = (ts: number) => new Date(ts * 1000).toLocaleString();

  const outcomeVariant = (outcome: string) =>
    outcome === "ok" ? "secondary" : outcome === "denied" ? "destructive" : "outline";

  onMount(load);
</script>

<div class="flex flex-col gap-4 p-4">
  <Card.Root>
    <Card.Header>
      <Card.Title>Audit log</Card.Title>
      <Card.Description>
        Every administrative change, who made it, and what it altered. Append-only: entries cannot be edited or removed
        except by the retention policy.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex flex-col gap-1">
          <Label for="f-action">Action</Label>
          <Input id="f-action" bind:value={filterAction} placeholder="storeMonitorData" class="w-56" />
        </div>
        <div class="flex flex-col gap-1">
          <Label for="f-actor">Actor id</Label>
          <Input id="f-actor" bind:value={filterActor} placeholder="1" class="w-32" />
        </div>
        <div class="flex flex-col gap-1">
          <Label for="f-outcome">Outcome</Label>
          <Input id="f-outcome" bind:value={filterOutcome} placeholder="ok / denied / error" class="w-44" />
        </div>
        <Button onclick={applyFilters} disabled={loading}>Filter</Button>
      </div>
    </Card.Content>
  </Card.Root>

  {#if loading}
    <div class="flex justify-center p-8"><Spinner /></div>
  {:else if error}
    <div class="text-destructive p-4 text-sm">{error}</div>
  {:else if rows.length === 0}
    <div class="text-muted-foreground p-8 text-center text-sm">No audit entries match these filters.</div>
  {:else}
    <div class="overflow-x-auto rounded border">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>When</Table.Head>
            <Table.Head>Actor</Table.Head>
            <Table.Head>Action</Table.Head>
            <Table.Head>Target</Table.Head>
            <Table.Head>Outcome</Table.Head>
            <Table.Head></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each rows as row (row.id)}
            <Table.Row>
              <Table.Cell class="whitespace-nowrap text-xs">{when(row.ts)}</Table.Cell>
              <Table.Cell class="text-xs">
                {row.actor_label ?? row.actor_id ?? "-"}
                <span class="text-muted-foreground">({row.actor_type})</span>
              </Table.Cell>
              <Table.Cell class="font-mono text-xs">{row.action}</Table.Cell>
              <Table.Cell class="text-xs">
                {#if row.target_type}{row.target_type}{/if}
                {#if row.target_id}<span class="text-muted-foreground"> {row.target_id}</span>{/if}
              </Table.Cell>
              <Table.Cell><Badge variant={outcomeVariant(row.outcome)}>{row.outcome}</Badge></Table.Cell>
              <Table.Cell>
                {#if row.before_json || row.after_json || row.meta_json}
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => (expanded = expanded === row.id ? null : row.id)}
                  >
                    {expanded === row.id ? "Hide" : "Details"}
                  </Button>
                {/if}
              </Table.Cell>
            </Table.Row>
            {#if expanded === row.id}
              <Table.Row>
                <Table.Cell colspan={6} class="whitespace-normal">
                  <div class="bg-muted/40 grid gap-3 rounded p-3 text-xs md:grid-cols-2">
                    {#if row.before_json}
                      <div>
                        <div class="mb-1 font-semibold">Before</div>
                        <pre class="overflow-x-auto whitespace-pre-wrap">{row.before_json}</pre>
                      </div>
                    {/if}
                    {#if row.after_json}
                      <div>
                        <div class="mb-1 font-semibold">After</div>
                        <pre class="overflow-x-auto whitespace-pre-wrap">{row.after_json}</pre>
                      </div>
                    {/if}
                    {#if row.meta_json}
                      <div class="md:col-span-2">
                        <div class="mb-1 font-semibold">Payload</div>
                        <pre class="overflow-x-auto whitespace-pre-wrap">{row.meta_json}</pre>
                      </div>
                    {/if}
                    <div class="text-muted-foreground md:col-span-2">
                      request {row.request_id ?? "-"} &middot; {row.ip ?? "no ip"} &middot; status {row.status_code ??
                        "-"}
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
      <span class="text-muted-foreground">{total} entries</span>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" onclick={() => go(-1)} disabled={page <= 1}>Previous</Button>
        <span class="text-muted-foreground">Page {page} of {totalPages}</span>
        <Button variant="outline" size="sm" onclick={() => go(1)} disabled={page >= totalPages}>Next</Button>
      </div>
    </div>
  {/if}
</div>
