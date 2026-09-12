<script lang="ts">
  import { Label } from "$lib/components/ui/label/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import Copy from "@lucide/svelte/icons/copy";
  import Globe from "@lucide/svelte/icons/globe";
  import CheckIcon from "@lucide/svelte/icons/check";
  import * as InputGroup from "$lib/components/ui/input-group/index.js";
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import * as Command from "$lib/components/ui/command/index.js";
  import clientResolve from "$lib/client/resolver.js";
  import { resolve } from "$app/paths";
  import type { HeartbeatMonitorTypeData } from "$lib/server/types/monitor";
  import randomName from "@scaleway/random-name";
  import CopyButton from "$lib/components/CopyButton.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { cn } from "$lib/utils.js";
  import { tick } from "svelte";
  import { Cron } from "croner";

  let { data = $bindable(), tag = "" }: { data: HeartbeatMonitorTypeData; tag?: string } = $props();

  // Initialize defaults if not set
  if (!data.degradedRemainingMinutes) data.degradedRemainingMinutes = 5;
  if (!data.downRemainingMinutes) data.downRemainingMinutes = 10;

  $effect(() => {
    if (!data.secretString) data.secretString = randomName() + "-" + randomName();
  });

  // B11. A pattern is what switches the monitor into schedule mode, so the tab
  // reflects whether one is set rather than being stored separately.
  let mode = $state(data.expectedCron?.trim() ? "schedule" : "interval");
  // Switching back to the timeout must not throw away a pattern the operator
  // spent time on, so it is parked here rather than deleted.
  let parkedCron = $state(data.expectedCron ?? "");

  // A duplicate key in a keyed {#each} takes down the whole page, not just this
  // control, so the list is deduped even though no runtime is known to repeat.
  const timezones: string[] = Array.from(new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]));

  let tzOpen = $state(false);
  let tzTriggerRef = $state<HTMLButtonElement>(null!);

  function setMode(next: string) {
    mode = next;
    if (next === "schedule") {
      data.expectedCron = parkedCron || "0 2 * * *";
      if (!data.cronTimezone) {
        data.cronTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      }
      if (data.graceMinutes === undefined || data.graceMinutes === null) data.graceMinutes = 15;
    } else {
      parkedCron = data.expectedCron ?? "";
      data.expectedCron = "";
    }
  }

  function pickTimezone(tz: string) {
    data.cronTimezone = tz;
    tzOpen = false;
    tick().then(() => tzTriggerRef?.focus());
  }

  function formatIn(date: Date, tz: string): string {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        dateStyle: "medium",
        timeStyle: "short",
        hour12: false
      }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  // Parse the pattern as the operator types it. Getting this wrong silently is
  // the whole risk of a cron field, so the next runs are shown back to them.
  let preview = $derived.by(() => {
    const pattern = data.expectedCron?.trim();
    if (!pattern) return { ok: false as const, message: "Enter a schedule" };
    const tz = data.cronTimezone?.trim() || "UTC";
    try {
      const runs = new Cron(pattern, { timezone: tz }).nextRuns(3);
      if (!runs.length) return { ok: false as const, message: "This pattern never fires" };
      return { ok: true as const, runs: runs.map((r) => formatIn(r, tz)), tz };
    } catch (error: unknown) {
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
    }
  });

  function refreshSecret() {
    data.secretString = randomName() + "-" + randomName();
  }

  let heartbeatUrl = $derived(
    tag
      ? window.location.origin + clientResolve(resolve, `/ext/heartbeat/${tag}/${data.secretString}`)
      : "Save the monitor first to get the heartbeat URL"
  );
</script>

<div class="space-y-4">
  <Tabs.Root value={mode} onValueChange={setMode}>
    <Tabs.List>
      <Tabs.Trigger value="interval">Silence timeout</Tabs.Trigger>
      <Tabs.Trigger value="schedule">Expected schedule</Tabs.Trigger>
    </Tabs.List>

    <Tabs.Content value="interval" class="mt-4">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="flex flex-col">
          <InputGroup.Root>
            <InputGroup.Addon>
              <InputGroup.Text>
                <span class="text-degraded">DEGRADED</span>
                if no heartbeat received for
              </InputGroup.Text>
            </InputGroup.Addon>
            <InputGroup.Input
              class="text-right"
              id="hb-degraded"
              bind:value={data.degradedRemainingMinutes}
              placeholder="5"
            />
            <InputGroup.Addon align="inline-end">
              <InputGroup.Text>minutes</InputGroup.Text>
            </InputGroup.Addon>
          </InputGroup.Root>
          <p class="text-muted-foreground mt-1 text-xs">
            Mark as DEGRADED if no heartbeat received for this many minutes
          </p>
        </div>
        <div class="flex flex-col">
          <InputGroup.Root>
            <InputGroup.Addon>
              <InputGroup.Text>
                <span class="text-down">DOWN</span> if no heartbeat received for
              </InputGroup.Text>
            </InputGroup.Addon>
            <InputGroup.Input class="text-right" id="hb-down" bind:value={data.downRemainingMinutes} placeholder="10" />
            <InputGroup.Addon align="inline-end">
              <InputGroup.Text>minutes</InputGroup.Text>
            </InputGroup.Addon>
          </InputGroup.Root>
          <p class="text-muted-foreground mt-1 text-xs">Mark as DOWN if no heartbeat received for this many minutes</p>
        </div>
      </div>
      <p class="text-muted-foreground mt-3 text-xs">
        Best for a job that runs continuously or on a short loop. For a job that runs at a fixed time, an expected
        schedule alerts as soon as it is late instead of waiting out a whole timeout.
      </p>
    </Tabs.Content>

    <Tabs.Content value="schedule" class="mt-4">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="flex flex-col">
          <Label class="mb-2" for="hb-cron">Expected to run</Label>
          <InputGroup.Root>
            <InputGroup.Addon>
              <InputGroup.Text>cron</InputGroup.Text>
            </InputGroup.Addon>
            <InputGroup.Input id="hb-cron" bind:value={data.expectedCron} placeholder="0 2 * * *" />
          </InputGroup.Root>
          <p class="text-muted-foreground mt-1 text-xs">Five fields: minute, hour, day of month, month, day of week</p>
        </div>

        <div class="flex flex-col">
          <Label class="mb-2" for="hb-tz">Timezone</Label>
          <Popover.Root bind:open={tzOpen}>
            <Popover.Trigger bind:ref={tzTriggerRef}>
              {#snippet child({ props })}
                <Button
                  {...props}
                  id="hb-tz"
                  variant="outline"
                  role="combobox"
                  aria-expanded={tzOpen}
                  class="justify-start font-normal"
                >
                  <Globe class="size-4" />
                  <span class="truncate">{data.cronTimezone || "UTC"}</span>
                </Button>
              {/snippet}
            </Popover.Trigger>
            <Popover.Content class="w-[280px] p-0">
              <Command.Root>
                <Command.Input placeholder="Search timezone..." />
                <Command.List class="max-h-60">
                  <Command.Empty>No timezone found.</Command.Empty>
                  <Command.Group>
                    {#each timezones as tz (tz)}
                      <Command.Item value={tz} onSelect={() => pickTimezone(tz)} class="text-xs">
                        <CheckIcon
                          class={cn("me-2 size-4", (data.cronTimezone || "UTC") !== tz && "text-transparent")}
                        />
                        {tz}
                      </Command.Item>
                    {/each}
                  </Command.Group>
                </Command.List>
              </Command.Root>
            </Popover.Content>
          </Popover.Root>
          <p class="text-muted-foreground mt-1 text-xs">The schedule is read in this zone, including across DST</p>
        </div>
      </div>

      <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="flex flex-col">
          <InputGroup.Root>
            <InputGroup.Addon>
              <InputGroup.Text>Grace period</InputGroup.Text>
            </InputGroup.Addon>
            <InputGroup.Input class="text-right" id="hb-grace" bind:value={data.graceMinutes} placeholder="15" />
            <InputGroup.Addon align="inline-end">
              <InputGroup.Text>minutes</InputGroup.Text>
            </InputGroup.Addon>
          </InputGroup.Root>
          <p class="text-muted-foreground mt-1 text-xs">
            How long after the expected time the run may still arrive before it counts as late
          </p>
        </div>

        <div class="flex flex-col">
          <Label class="mb-2">Next expected runs</Label>
          {#if preview.ok}
            <ul class="text-muted-foreground space-y-1 text-xs">
              {#each preview.runs as run, i (i)}
                <li>{run}</li>
              {/each}
            </ul>
            <p class="text-muted-foreground mt-1 text-xs">Shown in {preview.tz}</p>
          {:else}
            <p class="text-down text-xs">{preview.message}</p>
          {/if}
        </div>
      </div>

      <div class="bg-muted/40 mt-4 rounded-md p-3">
        <p class="text-muted-foreground text-xs">
          A run that arrives within the grace period is <span class="text-up">UP</span>. Miss one window and the monitor
          is <span class="text-degraded">DEGRADED</span> (late). Miss two in a row and it is
          <span class="text-down">DOWN</span> (not running). If the pattern cannot be parsed, the silence timeout is used
          instead so a typo cannot take the monitor down.
        </p>
      </div>
    </Tabs.Content>
  </Tabs.Root>

  <div class="flex flex-col gap-2">
    <Label>Heartbeat URL</Label>
    <div>
      <div class="flex items-center gap-2">
        <InputGroup.Root>
          <InputGroup.Addon>
            <InputGroup.Text>
              <Badge>GET | POST</Badge>
            </InputGroup.Text>
          </InputGroup.Addon>
          <InputGroup.Input class="text-muted-foreground" id="hb-secret" bind:value={heartbeatUrl} readonly />
          <InputGroup.Addon align="inline-end">
            <InputGroup.Button variant="secondary" onclick={refreshSecret}>New URL</InputGroup.Button>

            <CopyButton variant="ghost" size="icon-sm" text={heartbeatUrl}>
              <Copy class="size-4" />
            </CopyButton>
          </InputGroup.Addon>
        </InputGroup.Root>
      </div>
      <p class="text-muted-foreground mt-1 text-xs">Send a GET or POST request to this URL to record a heartbeat</p>
      <p class="text-muted-foreground mt-1 text-xs">
        A job can also report its own outcome: add <code>?exit_code=1</code> to say the run failed, and
        <code>?duration_ms=1234</code> to record how long it took. A failed run is DOWN straight away, without waiting for
        a missed window.
      </p>
    </div>
  </div>
</div>
