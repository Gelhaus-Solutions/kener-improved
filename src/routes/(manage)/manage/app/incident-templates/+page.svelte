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
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import SaveIcon from "@lucide/svelte/icons/save";
  import Loader from "@lucide/svelte/icons/loader";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import TrashIcon from "@lucide/svelte/icons/trash";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import { toast } from "svelte-sonner";
  import { resolve } from "$app/paths";
  import clientResolver from "$lib/client/resolver.js";
  import type {
    IncidentTemplate,
    TemplateComponent,
    TemplateVariable
  } from "$lib/server/types/incidentTemplate.js";
  import type { MonitorRecord } from "$lib/server/types/db.js";

  let loading = $state(true);
  let saving = $state(false);
  let templates = $state<IncidentTemplate[]>([]);
  let monitors = $state<MonitorRecord[]>([]);

  let editorOpen = $state(false);
  let editingId = $state<number | null>(null);
  let deleteTarget = $state<IncidentTemplate | null>(null);

  let name = $state("");
  let description = $state("");
  let titleTemplate = $state("");
  let bodyTemplate = $state("");
  let defaultSeverity = $state("");
  let defaultState = $state("");
  let components = $state<TemplateComponent[]>([]);
  let variables = $state<TemplateVariable[]>([]);
  let isGlobal = $state(true);

  const SEVERITIES = [
    { value: "", label: "Leave unset" },
    { value: "NONE", label: "None" },
    { value: "MINOR", label: "Minor" },
    { value: "MAJOR", label: "Major" },
    { value: "CRITICAL", label: "Critical" },
    { value: "MAINTENANCE", label: "Maintenance" }
  ];
  const STATES = [
    { value: "", label: "Leave unset" },
    { value: "INVESTIGATING", label: "Investigating" },
    { value: "IDENTIFIED", label: "Identified" },
    { value: "MONITORING", label: "Monitoring" },
    { value: "RESOLVED", label: "Resolved" }
  ];
  const IMPACTS = [
    { value: "MAJOR_OUTAGE", label: "Major Outage" },
    { value: "PARTIAL_OUTAGE", label: "Partial Outage" },
    { value: "DEGRADED_PERFORMANCE", label: "Degraded Performance" },
    { value: "UNDER_MAINTENANCE", label: "Under Maintenance" },
    { value: "OPERATIONAL", label: "Operational" }
  ];
  const VARIABLE_TYPES = [
    { value: "text", label: "Single line" },
    { value: "textarea", label: "Multi line" },
    { value: "select", label: "Choice" },
    { value: "number", label: "Number" }
  ];

  const labelFor = (list: Array<{ value: string; label: string }>, v: string, fallback: string) =>
    list.find((i) => i.value === v)?.label ?? fallback;

  async function call(action: string, data: unknown = {}) {
    const response = await fetch(clientResolver(resolve, "/manage/api"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, data })
    });
    return await response.json();
  }

  async function load() {
    loading = true;
    try {
      const [list, monitorList] = await Promise.all([call("getIncidentTemplates"), call("getMonitors", {})]);
      if (!list?.error) templates = list;
      if (Array.isArray(monitorList)) monitors = monitorList;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load templates");
    } finally {
      loading = false;
    }
  }

  function startNew() {
    editingId = null;
    name = "";
    description = "";
    titleTemplate = "";
    bodyTemplate = "";
    defaultSeverity = "";
    defaultState = "";
    components = [];
    variables = [];
    isGlobal = true;
    editorOpen = true;
  }

  function startEdit(template: IncidentTemplate) {
    editingId = template.id;
    name = template.name;
    description = template.description ?? "";
    titleTemplate = template.title_template;
    bodyTemplate = template.body_template ?? "";
    defaultSeverity = template.default_severity ?? "";
    defaultState = template.default_state ?? "";
    components = template.default_components.map((c) => ({ ...c }));
    variables = template.variables.map((v) => ({ ...v, options: [...v.options] }));
    isGlobal = template.is_global !== "NO";
    editorOpen = true;
  }

  async function save() {
    saving = true;
    try {
      const result = await call("saveIncidentTemplate", {
        id: editingId,
        name,
        description,
        title_template: titleTemplate,
        body_template: bodyTemplate,
        default_severity: defaultSeverity,
        default_state: defaultState,
        default_components: components,
        variables,
        is_global: isGlobal ? "YES" : "NO"
      });
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success(editingId ? "Template updated" : "Template created");
      editorOpen = false;
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save the template");
    } finally {
      saving = false;
    }
  }

  async function remove(template: IncidentTemplate) {
    const result = await call("deleteIncidentTemplate", { id: template.id });
    if (result?.error) {
      toast.error(result.error);
      return;
    }
    toast.success("Template deleted");
    deleteTarget = null;
    await load();
  }

  function addVariable() {
    variables = [...variables, { key: "", label: "", type: "text", required: false, default: "", options: [] }];
  }

  function addComponent() {
    const taken = new Set(components.map((c) => c.monitor_tag));
    const next = monitors.find((m) => !taken.has(m.tag));
    if (!next) return;
    components = [...components, { monitor_tag: next.tag, component_impact: "MAJOR_OUTAGE" }];
  }

  $effect(() => {
    void load();
  });
</script>

<div class="flex flex-col gap-4 p-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div>
      <h1 class="text-2xl font-semibold">Incident Templates</h1>
      <p class="text-muted-foreground text-sm">
        Pre-written incident text per scenario, so the first update goes out in seconds rather than minutes. Using one
        creates an ordinary incident.
      </p>
    </div>
    <Button onclick={startNew}>
      <PlusIcon class="size-4" />
      New template
    </Button>
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><Spinner /></div>
  {:else if templates.length === 0}
    <Card.Root>
      <Card.Content class="flex flex-col items-center gap-3 py-12 text-center">
        <FileTextIcon class="text-muted-foreground size-8 opacity-50" />
        <p class="text-muted-foreground text-sm">
          No templates yet. A template is worth writing for the outage you have had twice.
        </p>
      </Card.Content>
    </Card.Root>
  {:else}
    <div class="grid gap-3">
      {#each templates as template (template.id)}
        <Card.Root>
          <Card.Content class="flex flex-wrap items-start justify-between gap-4 pt-6">
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium">{template.name}</span>
                {#if template.default_severity}
                  <Badge variant="outline">{template.default_severity}</Badge>
                {/if}
                <Badge variant="secondary">Used {template.usage_count}×</Badge>
              </div>
              {#if template.description}
                <p class="text-muted-foreground text-sm">{template.description}</p>
              {/if}
              <p class="text-muted-foreground truncate font-mono text-xs">{template.title_template}</p>
              {#if template.variables.length > 0}
                <p class="text-muted-foreground text-xs">
                  Variables: {template.variables.map((v) => v.key).join(", ")}
                </p>
              {/if}
            </div>
            <div class="flex gap-2">
              <Button variant="outline" size="sm" onclick={() => startEdit(template)}>Edit</Button>
              <Button variant="ghost" size="icon" onclick={() => (deleteTarget = template)}>
                <TrashIcon class="size-4" />
              </Button>
            </div>
          </Card.Content>
        </Card.Root>
      {/each}
    </div>
  {/if}
</div>

<Dialog.Root bind:open={editorOpen}>
  <Dialog.Content class="max-h-[90vh] max-w-3xl overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>{editingId ? "Edit template" : "New template"}</Dialog.Title>
      <Dialog.Description>
        Write <code>{"{{name}}"}</code> where an operator should fill something in, then declare it below. The site
        variables from trigger templates work here too, plus
        <code>{"{{monitors}}"}</code>, <code>{"{{now}}"}</code> and <code>{"{{severity}}"}</code>.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-5 py-2">
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-2">
          <Label for="tpl-name">Name</Label>
          <Input id="tpl-name" bind:value={name} placeholder="Database failover" />
        </div>
        <div class="space-y-2">
          <Label for="tpl-desc">Description</Label>
          <Input id="tpl-desc" bind:value={description} placeholder="When to reach for this one" />
        </div>
      </div>

      <div class="space-y-2">
        <Label for="tpl-title">Incident title</Label>
        <Input id="tpl-title" bind:value={titleTemplate} placeholder="{'{{service}}'} is degraded" />
      </div>

      <div class="space-y-2">
        <Label for="tpl-body">First update</Label>
        <Textarea
          id="tpl-body"
          rows={5}
          bind:value={bodyTemplate}
          placeholder="We are investigating reports of problems with {'{{service}}'}."
        />
        <p class="text-muted-foreground text-xs">Markdown. Posted as the incident's first comment.</p>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-2">
          <Label>Severity</Label>
          <Select.Root type="single" value={defaultSeverity} onValueChange={(v) => (defaultSeverity = v ?? "")}>
            <Select.Trigger class="w-full">{labelFor(SEVERITIES, defaultSeverity, "Leave unset")}</Select.Trigger>
            <Select.Content>
              {#each SEVERITIES as severity (severity.value)}
                <Select.Item value={severity.value}>{severity.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="space-y-2">
          <Label>Starting state</Label>
          <Select.Root type="single" value={defaultState} onValueChange={(v) => (defaultState = v ?? "")}>
            <Select.Trigger class="w-full">{labelFor(STATES, defaultState, "Leave unset")}</Select.Trigger>
            <Select.Content>
              {#each STATES as state (state.value)}
                <Select.Item value={state.value}>{state.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      </div>

      <!-- Components -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <Label>Components to attach</Label>
          <Button size="sm" variant="outline" onclick={addComponent}>
            <PlusIcon class="size-4" />
            Add
          </Button>
        </div>
        {#if components.length === 0}
          <p class="text-muted-foreground text-xs">
            None. The incident is created with no components, and an operator attaches them by hand.
          </p>
        {:else}
          <div class="space-y-2">
            {#each components as component, i (i)}
              <div class="flex gap-2">
                <Select.Root
                  type="single"
                  value={component.monitor_tag}
                  onValueChange={(v) => {
                    if (v) components[i].monitor_tag = v;
                  }}
                >
                  <Select.Trigger class="flex-1">
                    {monitors.find((m) => m.tag === component.monitor_tag)?.name ?? component.monitor_tag}
                  </Select.Trigger>
                  <Select.Content>
                    {#each monitors as monitor (monitor.tag)}
                      <Select.Item value={monitor.tag}>{monitor.name}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
                <Select.Root
                  type="single"
                  value={component.component_impact}
                  onValueChange={(v) => {
                    if (v) components[i].component_impact = v;
                  }}
                >
                  <Select.Trigger class="w-56">
                    {labelFor(IMPACTS, component.component_impact, "Major Outage")}
                  </Select.Trigger>
                  <Select.Content>
                    {#each IMPACTS as impact (impact.value)}
                      <Select.Item value={impact.value}>{impact.label}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
                <Button
                  variant="ghost"
                  size="icon"
                  onclick={() => (components = components.filter((_, j) => j !== i))}
                >
                  <TrashIcon class="size-4" />
                </Button>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Variables -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <Label>Variables</Label>
          <Button size="sm" variant="outline" onclick={addVariable}>
            <PlusIcon class="size-4" />
            Add
          </Button>
        </div>
        {#if variables.length === 0}
          <p class="text-muted-foreground text-xs">
            None. The template renders exactly as written, which is fine for text that never changes.
          </p>
        {:else}
          <div class="space-y-3">
            {#each variables as variable, i (i)}
              <div class="space-y-2 rounded-md border p-3">
                <div class="grid gap-2 sm:grid-cols-3">
                  <Input
                    placeholder="key"
                    class="font-mono"
                    value={variable.key}
                    oninput={(e) => (variables[i].key = (e.currentTarget as HTMLInputElement).value)}
                  />
                  <Input
                    placeholder="Label shown to the operator"
                    value={variable.label}
                    oninput={(e) => (variables[i].label = (e.currentTarget as HTMLInputElement).value)}
                  />
                  <Select.Root
                    type="single"
                    value={variable.type}
                    onValueChange={(v) => {
                      if (v) variables[i].type = v as TemplateVariable["type"];
                    }}
                  >
                    <Select.Trigger class="w-full">
                      {labelFor(VARIABLE_TYPES, variable.type, "Single line")}
                    </Select.Trigger>
                    <Select.Content>
                      {#each VARIABLE_TYPES as type (type.value)}
                        <Select.Item value={type.value}>{type.label}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </div>
                <div class="grid gap-2 sm:grid-cols-3">
                  <Input
                    placeholder="Default value"
                    value={variable.default}
                    oninput={(e) => (variables[i].default = (e.currentTarget as HTMLInputElement).value)}
                  />
                  {#if variable.type === "select"}
                    <Input
                      class="sm:col-span-2"
                      placeholder="Choices, comma separated"
                      value={variable.options.join(", ")}
                      oninput={(e) => {
                        variables[i].options = (e.currentTarget as HTMLInputElement).value
                          .split(",")
                          .map((o) => o.trim())
                          .filter((o) => o !== "");
                      }}
                    />
                  {/if}
                </div>
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <Switch
                      checked={variable.required}
                      onCheckedChange={(v) => (variables[i].required = v)}
                    />
                    <span class="text-sm">Required</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onclick={() => (variables = variables.filter((_, j) => j !== i))}
                  >
                    <TrashIcon class="size-4" />
                  </Button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (editorOpen = false)}>Cancel</Button>
      <Button onclick={save} disabled={saving}>
        {#if saving}
          <Loader class="size-4 animate-spin" />
        {:else}
          <SaveIcon class="size-4" />
        {/if}
        Save
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={deleteTarget !== null} onOpenChange={(o) => !o && (deleteTarget = null)}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Delete template</Dialog.Title>
      <Dialog.Description>
        Incidents already opened from "{deleteTarget?.name}" keep working and keep recording that they came from it.
        Only the template goes.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (deleteTarget = null)}>Cancel</Button>
      <Button variant="destructive" onclick={() => deleteTarget && remove(deleteTarget)}>Delete</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
