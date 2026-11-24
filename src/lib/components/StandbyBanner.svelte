<script lang="ts">
  import { page } from "$app/state";
  import { t } from "$lib/stores/i18n";
  import { formatDate } from "$lib/stores/datetime";

  interface Props {
    /** UTC seconds of the data shown, or null before the first pull. */
    dataAt: number | null;
  }

  let { dataAt }: Props = $props();
</script>

<div
  role="status"
  class="bg-background border-degraded mb-6 flex w-full flex-col gap-1 rounded-3xl border px-4 pt-2 pb-4"
>
  <span class="text-degraded text-base font-medium">{$t("Status data is out of date")}</span>
  <p class="text-muted-foreground text-sm">
    {#if dataAt !== null}
      {$t("Last updated %time. Current status unknown.", {
        time: $formatDate(dataAt, page.data.dateAndTimeFormat.datePlusTime)
      })}
    {:else}
      {$t("No data yet. Current status unknown.")}
    {/if}
  </p>
</div>
