<script lang="ts">
  import ThemePlus from "$lib/components/ThemePlus.svelte";
  import IncidentHistory from "$lib/components/IncidentHistory.svelte";
  import * as Item from "$lib/components/ui/item/index.js";
  import { t } from "$lib/stores/i18n";

  // G7. Deliberately thin: everything lives in IncidentHistory so this route and
  // `[page_path]/history` cannot drift apart the way the two status pages did.
  let { data } = $props();
</script>

<svelte:head>
  <title>{$t("Incident History")} - {data.siteName}</title>
  <meta name="description" content={$t("Searchable history of past incidents")} />
</svelte:head>

<div class="flex flex-col gap-3 sm:gap-4">
  <ThemePlus monitor_tags={[]} />
  <div class="px-3 py-2 sm:px-4">
    <Item.Root class="px-0 py-0">
      <Item.Content>
        <h1><Item.Title class="text-2xl sm:text-3xl">{$t("Incident History")}</Item.Title></h1>
      </Item.Content>
    </Item.Root>
  </div>
  <IncidentHistory pagePath="" />
</div>
