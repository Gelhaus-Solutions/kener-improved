<script lang="ts">
  import { resolve } from "$app/paths";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import CheckCircle2Icon from "@lucide/svelte/icons/check-circle-2";
  import Monitor from "@lucide/svelte/icons/monitor";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import * as Item from "$lib/components/ui/item/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import mdToHTML from "$lib/marked";
  import ThemePlus from "$lib/components/ThemePlus.svelte";
  import { SveltePurify } from "@humanspeak/svelte-purify";
  import { t } from "$lib/stores/i18n";
  import { formatDate, formatDuration } from "$lib/stores/datetime";
  import clientResolver, { absoluteResolve } from "$lib/client/resolver.js";
  import { page } from "$app/state";

  let { data } = $props();
</script>

<svelte:head>
  <title>{data.incident.title + " - " + data.siteName}</title>
  <meta property="og:title" content={data.incident.title + " - " + data.siteName} />
  <meta property="og:type" content="article" />
  <meta name="twitter:card" content="summary_large_image" />
  {#if data.comments.length > 0}
    <meta name="description" content={data.comments[0].comment} />
    <meta property="og:description" content={data.comments[0].comment} />
  {/if}
  {#if data.socialPreviewImage}
    <meta property="og:image" content={absoluteResolve(resolve, data.siteUrl, data.socialPreviewImage)} />
    <meta name="twitter:image" content={absoluteResolve(resolve, data.siteUrl, data.socialPreviewImage)} />
  {/if}
</svelte:head>

<div class="flex flex-col gap-3">
  <ThemePlus />
  <div class="flex flex-col gap-2 px-4 py-2">
    <Item.Root class="mb-4 px-0">
      <Item.Content class="min-w-0 flex-1 px-0">
        <h1>
          <Item.Title class="text-3xl wrap-break-word">{data.incident.title}</Item.Title>
        </h1>
      </Item.Content>
    </Item.Root>
  </div>
  <div class="grid min-w-0 gap-6 lg:grid-cols-3">
    <!-- Comments Timeline (Main Content) -->
    <div class="min-w-0 lg:col-span-2">
      <div class="bg-background min-w-0 rounded-3xl border">
        <div class="flex items-center justify-between border-b p-4">
          <Badge variant="secondary" class="gap-1">
            <MessageSquare class="h-3 w-3" />
            {$t("Updates (%count)", { count: String(data.comments.length) })}
          </Badge>
        </div>

        {#if data.comments.length === 0}
          <div class="text-muted-foreground p-8 text-center">
            <MessageSquare class="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p>{$t("No updates yet")}</p>
          </div>
        {:else}
          <div class="divide-y">
            {#each data.comments as comment (comment.id)}
              <div class="min-w-0 p-4">
                <div class="mb-2 flex items-center justify-between gap-2">
                  <Badge variant="outline" class="text-{comment.state.toLowerCase()} rounded-none border-0 p-0">
                    {$t(comment.state)}
                  </Badge>
                  <span class="text-muted-foreground text-xs">
                    {$formatDate(comment.commented_at, page.data.dateAndTimeFormat.datePlusTime)}
                  </span>
                </div>
                <div class="prose prose-sm dark:prose-invert max-w-none min-w-0 overflow-x-auto wrap-break-word">
                  <SveltePurify html={mdToHTML(comment.comment)} />
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Postmortem (C1). Rendered under the timeline, in the main column, because
           it is the document the incident produced rather than a fact about it. -->
      {#if data.postmortem}
        <div id="postmortem" class="mt-6 min-w-0">
          <div class="bg-background min-w-0 rounded-3xl border">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b p-4">
              <Badge variant="secondary" class="gap-1">
                <FileTextIcon class="h-3 w-3" />
                {$t("Postmortem")}
              </Badge>
              {#if data.postmortem.published_at}
                <span class="text-muted-foreground text-xs">
                  {$formatDate(data.postmortem.published_at, page.data.dateAndTimeFormat.datePlusTime)}
                </span>
              {/if}
            </div>

            <div class="min-w-0 space-y-6 p-4">
              <h2 class="text-xl font-semibold wrap-break-word">{data.postmortem.title}</h2>

              {#each [{ heading: $t("Summary"), body: data.postmortem.summary }, { heading: $t("Root cause"), body: data.postmortem.root_cause }, { heading: $t("Impact"), body: data.postmortem.impact_description }, { heading: $t("Resolution"), body: data.postmortem.resolution }] as section (section.heading)}
                {#if section.body}
                  <div class="min-w-0">
                    <h3 class="text-muted-foreground mb-1 text-sm font-medium tracking-wide uppercase">
                      {section.heading}
                    </h3>
                    <div class="prose prose-sm dark:prose-invert max-w-none min-w-0 overflow-x-auto wrap-break-word">
                      <SveltePurify html={mdToHTML(section.body)} />
                    </div>
                  </div>
                {/if}
              {/each}

              {#if data.postmortem.body_md}
                <div class="prose prose-sm dark:prose-invert max-w-none min-w-0 overflow-x-auto wrap-break-word">
                  <SveltePurify html={mdToHTML(data.postmortem.body_md)} />
                </div>
              {/if}

              <!-- The hand-written timeline. Shown only when the author chose one:
                   with COMMENTS as the source the updates above are the timeline,
                   and repeating them here would print the incident twice. -->
              {#if data.postmortem.timeline_source === "CUSTOM" && data.postmortem.timeline_custom.length > 0}
                <div class="min-w-0">
                  <h3 class="text-muted-foreground mb-2 text-sm font-medium tracking-wide uppercase">
                    {$t("Timeline")}
                  </h3>
                  <ol class="divide-border divide-y">
                    {#each data.postmortem.timeline_custom as entry (entry.at)}
                      <li class="flex min-w-0 flex-col gap-1 py-2 sm:flex-row sm:gap-4">
                        <span class="text-muted-foreground shrink-0 text-xs sm:w-44">
                          {$formatDate(entry.at, page.data.dateAndTimeFormat.datePlusTime)}
                        </span>
                        <span class="min-w-0 text-sm wrap-break-word">{entry.text}</span>
                      </li>
                    {/each}
                  </ol>
                </div>
              {/if}

              {#if data.postmortem.action_items.length > 0}
                <div class="min-w-0">
                  <h3 class="text-muted-foreground mb-2 text-sm font-medium tracking-wide uppercase">
                    {$t("Follow-up actions")}
                  </h3>
                  <ul class="space-y-2">
                    {#each data.postmortem.action_items as item, i (i)}
                      <li class="flex min-w-0 items-start gap-2 text-sm">
                        <CheckCircle2Icon
                          class="mt-0.5 h-4 w-4 shrink-0 {item.status === 'DONE'
                            ? 'text-up'
                            : 'text-muted-foreground opacity-40'}"
                        />
                        <span class="min-w-0 wrap-break-word">
                          {item.text}
                          {#if item.owner}
                            <span class="text-muted-foreground"> - {item.owner}</span>
                          {/if}
                        </span>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    </div>

    <!-- Affected Monitors (Sidebar) -->
    <div class="lg:col-span-1">
      <div class="bg-background rounded-3xl border">
        <div class="flex items-center justify-between border-b p-4">
          <Badge variant="secondary" class="gap-1">
            <Monitor class="h-3 w-3" />
            {$t("Affected Monitors (%count)", { count: String(data.affectedMonitors.length) })}
          </Badge>
        </div>

        {#if data.affectedMonitors.length === 0}
          <div class="text-muted-foreground p-8 text-center">
            <Monitor class="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p>{$t("No monitors affected")}</p>
          </div>
        {:else}
          <div class="">
            {#each data.affectedMonitors as monitor (monitor.monitor_tag)}
              <div class="border-b last:border-b-0">
                <Item.Root>
                  <Item.Media>
                    <Tooltip.Root>
                      <Tooltip.Trigger>
                        <div class="h-6 w-6 rounded-full bg-{monitor.monitor_impact?.toLowerCase()}"></div>
                      </Tooltip.Trigger>
                      <Tooltip.Content arrowClasses="bg-foreground">
                        <div class="text-xs font-medium">
                          {$t("Impact")}: {monitor.monitor_impact || $t("Unknown impact")}
                        </div>
                      </Tooltip.Content>
                    </Tooltip.Root>
                  </Item.Media>
                  <Item.Content>
                    <Item.Title>{monitor.monitor_name}</Item.Title>
                    <Item.Description>
                      {#if monitor.monitor_impact}
                        <span class="text-{monitor.monitor_impact.toLowerCase()}">
                          {$t(monitor.monitor_impact)}
                        </span>
                      {:else}
                        {$t("Unknown impact")}
                      {/if}
                    </Item.Description>
                  </Item.Content>
                  <Item.Actions>
                    <Button
                      variant="outline"
                      href={clientResolver(resolve, `/monitors/${monitor.monitor_slug || monitor.monitor_tag}`)}
                      class="rounded-btn"
                      size="icon"
                    >
                      <ArrowRight class="h-4 w-4" />
                    </Button>
                  </Item.Actions>
                </Item.Root>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
