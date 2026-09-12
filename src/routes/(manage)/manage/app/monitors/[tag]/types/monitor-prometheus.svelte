<script lang="ts">
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let { data = $bindable() }: { data: any } = $props();

  const OPERATORS = [">", ">=", "<", "<=", "==", "!="] as const;
  const STATUS_OPTIONS = ["DOWN", "DEGRADED", "UP"] as const;

  // Initialize defaults if not set. `down` / `degraded` intentionally stay
  // undefined until the user enables them.
  if (!data.url) data.url = "";
  if (!data.query) data.query = "";
  if (!data.noDataStatus) data.noDataStatus = "DOWN";
  if (!data.errorStatus) data.errorStatus = "DOWN";
  if (!data.headers) data.headers = [];
  if (!data.timeout) data.timeout = 10000;
  if (data.allowSelfSignedCert === undefined) data.allowSelfSignedCert = false;
  // I6. Left undefined rather than defaulted to false, so the grandfathering
  // migration can tell "never decided" from "deliberately off".
  if (data.allowPlaintextSecrets === undefined) data.allowPlaintextSecrets = false;

  /**
   * I6. Whether this monitor would be refused at check time.
   *
   * Warns on a `$NAME` being *mentioned*, where the server refuses only when one
   * actually resolves: the browser cannot see the server's environment, and a
   * warning that appears when it might apply beats one that stays silent because
   * the variable happens to be unset on the machine rendering the page.
   */
  const mentionsSecret = $derived(
    /\$[A-Za-z_][A-Za-z0-9_]*/.test([data.url, JSON.stringify(data.headers ?? [])].filter(Boolean).join(" "))
  );
  const plaintextUrl = $derived(
    typeof data.url === "string" && data.url.length > 0 && !/^https:\/\//i.test(data.url.trim())
  );
  const wouldRefuse = $derived(mentionsSecret && plaintextUrl && data.allowPlaintextSecrets !== true);

  function toggleDown(on: boolean) {
    data.down = on ? { operator: ">", value: 0 } : undefined;
  }
  function toggleDegraded(on: boolean) {
    data.degraded = on ? { operator: ">", value: 0 } : undefined;
  }

  function addHeader() {
    data.headers = [...(data.headers || []), { key: "", value: "" }];
  }
  function removeHeader(index: number) {
    data.headers = data.headers?.filter((_: unknown, i: number) => i !== index);
  }
</script>

<div class="space-y-4">
  <div class="flex flex-col gap-2">
    <Label for="prom-url">URL <span class="text-destructive">*</span></Label>
    <Input id="prom-url" bind:value={data.url} placeholder="https://prometheus.example.com" />
  </div>

  <div class="flex flex-col gap-2">
    <Label for="prom-query">PromQL Query <span class="text-destructive">*</span></Label>
    <Textarea id="prom-query" bind:value={data.query} placeholder="up" rows={3} />
    <p class="text-muted-foreground mt-1 text-xs">
      Instant query. Aggregate multi-series results in PromQL (e.g. <code>max(...)</code>) — otherwise the first series
      is used.
    </p>
  </div>

  <!-- Down condition -->
  <div class="flex items-center space-x-2">
    <Switch id="prom-down-enabled" checked={!!data.down} onCheckedChange={toggleDown} />
    <Label for="prom-down-enabled">Down condition</Label>
  </div>
  {#if data.down}
    <div class="grid grid-cols-2 gap-4">
      <div class="flex flex-col gap-2">
        <Label for="prom-down-op">Operator</Label>
        <Select.Root
          type="single"
          value={data.down.operator}
          onValueChange={(v) => {
            if (v) data.down.operator = v;
          }}
        >
          <Select.Trigger id="prom-down-op" class="w-full">{data.down.operator}</Select.Trigger>
          <Select.Content>
            {#each OPERATORS as op}
              <Select.Item value={op}>{op}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex flex-col gap-2">
        <Label for="prom-down-val">Value</Label>
        <Input id="prom-down-val" type="number" bind:value={data.down.value} />
      </div>
    </div>
    <p class="text-muted-foreground -mt-2 text-xs">DOWN when metric value {data.down.operator} {data.down.value}.</p>
  {/if}

  <!-- Degraded condition -->
  <div class="flex items-center space-x-2">
    <Switch id="prom-degraded-enabled" checked={!!data.degraded} onCheckedChange={toggleDegraded} />
    <Label for="prom-degraded-enabled">Degraded condition</Label>
  </div>
  {#if data.degraded}
    <div class="grid grid-cols-2 gap-4">
      <div class="flex flex-col gap-2">
        <Label for="prom-degraded-op">Operator</Label>
        <Select.Root
          type="single"
          value={data.degraded.operator}
          onValueChange={(v) => {
            if (v) data.degraded.operator = v;
          }}
        >
          <Select.Trigger id="prom-degraded-op" class="w-full">{data.degraded.operator}</Select.Trigger>
          <Select.Content>
            {#each OPERATORS as op}
              <Select.Item value={op}>{op}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <div class="flex flex-col gap-2">
        <Label for="prom-degraded-val">Value</Label>
        <Input id="prom-degraded-val" type="number" bind:value={data.degraded.value} />
      </div>
    </div>
    <p class="text-muted-foreground -mt-2 text-xs">
      DEGRADED when metric value {data.degraded.operator}
      {data.degraded.value} (checked after DOWN).
    </p>
  {/if}

  <!-- No-data status -->
  <div class="flex flex-col gap-2">
    <Label for="prom-nodata">No-data status</Label>
    <Select.Root
      type="single"
      value={data.noDataStatus}
      onValueChange={(v) => {
        if (v) data.noDataStatus = v;
      }}
    >
      <Select.Trigger id="prom-nodata" class="w-full">{data.noDataStatus}</Select.Trigger>
      <Select.Content>
        {#each STATUS_OPTIONS as opt}
          <Select.Item value={opt}>{opt}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    <p class="text-muted-foreground mt-1 text-xs">Status recorded when the query returns no data.</p>
  </div>

  <div class="flex flex-col gap-2">
    <Label for="prom-error">Unreachable status</Label>
    <Select.Root
      type="single"
      value={data.errorStatus}
      onValueChange={(v) => {
        if (v) data.errorStatus = v;
      }}
    >
      <Select.Trigger id="prom-error" class="w-full">{data.errorStatus}</Select.Trigger>
      <Select.Content>
        {#each STATUS_OPTIONS as opt}
          <Select.Item value={opt}>{opt}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    <p class="text-muted-foreground mt-1 text-xs">
      Status recorded when Prometheus cannot be reached or answers unusably (timeout, HTTP error, malformed response).
      Distinct from no-data, which means the query ran and matched nothing.
    </p>
  </div>

  <!-- Headers -->
  <div>
    <div class="mb-2 flex items-center justify-between">
      <Label>Headers</Label>
      <Button variant="outline" size="sm" onclick={addHeader}>
        <Plus class="mr-1 size-4" />
        Add Header
      </Button>
    </div>
    {#if data.headers && data.headers.length > 0}
      <div class="space-y-2">
        {#each data.headers as header, index}
          <div class="flex items-center gap-2">
            <Input bind:value={header.key} placeholder="Header Key" class="flex-1" />
            <Input bind:value={header.value} placeholder="Header Value" class="flex-1" />
            <Button variant="ghost" size="icon" onclick={() => removeHeader(index)}>
              <X class="size-4" />
            </Button>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Timeout -->
  <div class="flex flex-col gap-2">
    <Label for="prom-timeout">Timeout (ms)</Label>
    <Input id="prom-timeout" type="number" bind:value={data.timeout} placeholder="10000" />
  </div>

  <!-- Proxy -->
  <div class="flex flex-col gap-2">
    <Label for="prom-proxy">Proxy URL</Label>
    <Input id="prom-proxy" bind:value={data.proxy} placeholder="http://user:$PROXY_PASS@proxy.internal:3128" />
    <p class="text-muted-foreground text-xs">Leave empty to use HTTP_PROXY / HTTPS_PROXY from the environment.</p>
  </div>

  <!-- Self-signed -->
  <div class="flex items-center space-x-2">
    <Switch id="prom-self-signed" bind:checked={data.allowSelfSignedCert} />
    <Label for="prom-self-signed">Allow Self-Signed Certificates</Label>
  </div>

  <!-- I6. Shown only when it applies, so it reads as a fact about this monitor
       rather than standing advice nobody looks at. -->
  {#if mentionsSecret}
    <div class="flex flex-col gap-2 rounded-md border p-3" class:border-amber-500={wouldRefuse}>
      <div class="flex items-center space-x-2">
        <Switch id="prom-plaintext-secrets" bind:checked={data.allowPlaintextSecrets} />
        <Label for="prom-plaintext-secrets">Allow secrets over plaintext</Label>
      </div>
      {#if wouldRefuse}
        <p class="text-sm text-amber-600">
          This monitor substitutes a secret and its URL is not <code>https://</code>, so the check will be refused
          rather than sending the credential in clear text. Switch the URL to <code>https://</code>, or turn this on if
          the endpoint is genuinely internal.
        </p>
      {:else}
        <p class="text-muted-foreground text-sm">
          On, the credential is sent even over an unencrypted URL. Leave it off unless the endpoint is genuinely
          internal.
        </p>
      {/if}
      <p class="text-muted-foreground text-xs">
        Also governs whether this monitor may be handed to a remote probe: the probe channel is unencrypted.
      </p>
    </div>
  {/if}
</div>
