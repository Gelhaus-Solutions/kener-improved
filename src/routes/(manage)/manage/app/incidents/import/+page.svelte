<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Breadcrumb from "$lib/components/ui/breadcrumb/index.js";
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import Loader from "@lucide/svelte/icons/loader";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import CheckCircle2Icon from "@lucide/svelte/icons/check-circle-2";
  import AlertTriangleIcon from "@lucide/svelte/icons/alert-triangle";
  import { toast } from "svelte-sonner";
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import clientResolver from "$lib/client/resolver.js";

  interface BackfillRow {
    title: string;
    start_date_time: number;
    end_date_time: number;
    severity?: string;
    write_timeline?: boolean;
    components?: Array<{ monitor_tag: string; component_impact: string }>;
    comments?: Array<{ comment: string; state?: string; commented_at?: number }>;
  }

  interface ValidationRow {
    index: number;
    title: string;
    problems: string[];
    overlay_rows: number;
  }

  let format = $state<"csv" | "json">("csv");
  let source = $state("");
  let parseError = $state<string | null>(null);
  let rows = $state<BackfillRow[]>([]);
  let validation = $state<{ results: ValidationRow[]; total_overlay_rows: number; ok: boolean } | null>(null);
  let validating = $state(false);
  let importing = $state(false);
  let writeTimeline = $state(true);

  const CSV_EXAMPLE = `title,start,end,severity,components,impact
Database failover,2026-03-14T09:00:00Z,2026-03-14T10:30:00Z,MAJOR,api|db,MAJOR_OUTAGE
Slow checkout,2026-04-02T13:15:00Z,2026-04-02T14:00:00Z,MINOR,checkout,DEGRADED_PERFORMANCE`;

  const JSON_EXAMPLE = `[
  {
    "title": "Database failover",
    "start_date_time": 1773478800,
    "end_date_time": 1773484200,
    "severity": "MAJOR",
    "components": [{ "monitor_tag": "db", "component_impact": "MAJOR_OUTAGE" }],
    "comments": [
      { "comment": "Investigating", "state": "INVESTIGATING", "commented_at": 1773478800 },
      { "comment": "Failed over", "state": "RESOLVED", "commented_at": 1773484200 }
    ]
  }
]`;

  /** Seconds from an ISO instant or a bare number. */
  function toSeconds(value: string): number {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? NaN : Math.floor(parsed / 1000);
  }

  /**
   * A deliberately small CSV reader.
   *
   * Splits on commas outside quotes and nothing more: no escapes, no embedded
   * newlines. Anything richer belongs in the JSON tab, and pulling in a CSV
   * library to parse a six-column import would be a dependency added for one
   * screen.
   */
  function splitCsvLine(line: string): string[] {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) {
        cells.push(cell);
        cell = "";
      } else cell += char;
    }
    cells.push(cell);
    return cells.map((c) => c.trim());
  }

  function parseCsv(text: string): BackfillRow[] {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    if (lines.length < 2) throw new Error("Needs a header row and at least one incident");

    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    const at = (name: string) => header.indexOf(name);
    const iTitle = at("title");
    const iStart = at("start");
    const iEnd = at("end");
    if (iTitle < 0 || iStart < 0 || iEnd < 0) throw new Error("Needs at least title, start and end columns");

    const iSeverity = at("severity");
    const iComponents = at("components");
    const iImpact = at("impact");
    const iComment = at("comment");

    return lines.slice(1).map((line, i) => {
      const cells = splitCsvLine(line);
      const start = toSeconds(cells[iStart] ?? "");
      const end = toSeconds(cells[iEnd] ?? "");
      if (Number.isNaN(start) || Number.isNaN(end)) {
        throw new Error(`Row ${i + 2}: start and end must be ISO instants or UTC seconds`);
      }

      const impact = (iImpact >= 0 ? cells[iImpact] : "") || "MAJOR_OUTAGE";
      const tags = (iComponents >= 0 ? cells[iComponents] : "")
        .split("|")
        .map((t) => t.trim())
        .filter((t) => t !== "");

      const comment = iComment >= 0 ? cells[iComment] : "";

      return {
        title: cells[iTitle] ?? "",
        start_date_time: start,
        end_date_time: end,
        severity: iSeverity >= 0 ? cells[iSeverity] || undefined : undefined,
        components: tags.map((monitor_tag) => ({ monitor_tag, component_impact: impact })),
        comments: comment ? [{ comment, state: "RESOLVED", commented_at: end }] : []
      };
    });
  }

  function parse() {
    parseError = null;
    validation = null;
    try {
      const parsed = format === "csv" ? parseCsv(source) : JSON.parse(source);
      if (!Array.isArray(parsed)) throw new Error("Expected an array of incidents");
      rows = parsed.map((r: BackfillRow) => ({ ...r, write_timeline: writeTimeline }));
    } catch (e) {
      rows = [];
      parseError = e instanceof Error ? e.message : "Could not read that";
    }
  }

  async function call(action: string, data: unknown) {
    const response = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    return await response.json();
  }

  async function validate() {
    parse();
    if (rows.length === 0) return;
    validating = true;
    try {
      const result = await call("validateIncidentBackfill", { incidents: rows });
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      validation = result;
    } finally {
      validating = false;
    }
  }

  async function runImport() {
    if (!validation?.ok) return;
    importing = true;
    try {
      const result = await call("backfillIncidents", { incidents: rows });
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`Imported ${result.count} incident${result.count === 1 ? "" : "s"}`);
      goto(clientResolver(resolve, "/manage/app/incidents"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      importing = false;
    }
  }

  async function onFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    source = await file.text();
    format = file.name.endsWith(".json") ? "json" : "csv";
    parse();
  }
</script>

<div class="flex flex-col gap-4 p-4">
  <Breadcrumb.Root>
    <Breadcrumb.List>
      <Breadcrumb.Item>
        <Breadcrumb.Link href={clientResolver(resolve, "/manage/app/incidents")}>Incidents</Breadcrumb.Link>
      </Breadcrumb.Item>
      <Breadcrumb.Separator />
      <Breadcrumb.Item>
        <Breadcrumb.Page>Import history</Breadcrumb.Page>
      </Breadcrumb.Item>
    </Breadcrumb.List>
  </Breadcrumb.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Import historical incidents</Card.Title>
      <Card.Description>
        Record outages that happened before this instance was watching, so uptime history and SLA reports are truthful.
        <strong>Nobody is notified</strong>: no emails, no webhooks, no triggers. Imported incidents also write the
        matching window into the monitor timelines, which is what makes the bars show them.
      </Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      <Tabs.Root value={format} onValueChange={(v) => (format = v as "csv" | "json")}>
        <Tabs.List>
          <Tabs.Trigger value="csv">CSV</Tabs.Trigger>
          <Tabs.Trigger value="json">JSON</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="csv" class="space-y-2 pt-3">
          <p class="text-muted-foreground text-xs">
            Columns: <code>title, start, end</code> required;
            <code>severity, components, impact, comment</code> optional. Times are ISO instants or UTC seconds.
            Components are separated by <code>|</code> and share one impact. For per-component impacts or a real
            timeline, use JSON.
          </p>
          <pre class="bg-muted overflow-x-auto rounded-md p-3 text-xs">{CSV_EXAMPLE}</pre>
        </Tabs.Content>

        <Tabs.Content value="json" class="space-y-2 pt-3">
          <p class="text-muted-foreground text-xs">
            An array of incidents. Each may carry its own components and its own timeline of comments.
          </p>
          <pre class="bg-muted overflow-x-auto rounded-md p-3 text-xs">{JSON_EXAMPLE}</pre>
        </Tabs.Content>
      </Tabs.Root>

      <div class="space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="src">Paste, or choose a file</Label>
          <input
            type="file"
            accept=".csv,.json,text/csv,application/json"
            class="text-muted-foreground text-xs"
            onchange={onFile}
          />
        </div>
        <Textarea id="src" rows={10} bind:value={source} class="font-mono text-xs" />
      </div>

      <div class="flex items-start justify-between gap-4">
        <div>
          <Label for="write-timeline">Write the monitor timelines</Label>
          <p class="text-muted-foreground text-xs">
            On, because an incident that leaves no mark on the bars is the problem this fixes. Turn it off only when the
            timeline for this window is already correct and you are just writing up the incident.
          </p>
        </div>
        <Switch id="write-timeline" bind:checked={writeTimeline} />
      </div>

      {#if parseError}
        <p class="text-destructive flex items-center gap-1 text-sm">
          <AlertTriangleIcon class="size-4" />
          {parseError}
        </p>
      {/if}
    </Card.Content>
    <Card.Footer class="flex justify-end gap-2">
      <Button variant="outline" onclick={validate} disabled={validating || source.trim() === ""}>
        {#if validating}
          <Loader class="size-4 animate-spin" />
        {/if}
        Check it
      </Button>
      <Button onclick={runImport} disabled={!validation?.ok || importing}>
        {#if importing}
          <Loader class="size-4 animate-spin" />
        {:else}
          <UploadIcon class="size-4" />
        {/if}
        Import {rows.length > 0 ? rows.length : ""}
      </Button>
    </Card.Footer>
  </Card.Root>

  {#if validation}
    <Card.Root>
      <Card.Header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Card.Title>What would happen</Card.Title>
          <Badge variant={validation.ok ? "secondary" : "destructive"}>
            {validation.ok ? "Ready" : "Needs fixing"}
          </Badge>
        </div>
        <Card.Description>
          {validation.total_overlay_rows.toLocaleString()} timeline rows across {validation.results.length} incident{validation
            .results.length === 1
            ? ""
            : "s"}. Written in the background after the import, so this page will not wait for them.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <div class="divide-border divide-y">
          {#each validation.results as row (row.index)}
            <div class="flex items-start gap-2 py-2">
              {#if row.problems.length === 0}
                <CheckCircle2Icon class="text-up mt-0.5 size-4 shrink-0" />
              {:else}
                <AlertTriangleIcon class="text-destructive mt-0.5 size-4 shrink-0" />
              {/if}
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium wrap-break-word">{row.title || `Row ${row.index + 1}`}</p>
                {#if row.problems.length > 0}
                  <ul class="text-destructive list-inside list-disc text-xs">
                    {#each row.problems as problem (problem)}
                      <li>{problem}</li>
                    {/each}
                  </ul>
                {:else}
                  <p class="text-muted-foreground text-xs">
                    {row.overlay_rows.toLocaleString()} timeline rows
                  </p>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
