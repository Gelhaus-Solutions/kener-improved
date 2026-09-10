<script lang="ts">
  import EventsCard from "$lib/components/EventsCard.svelte";
  import { liveStatus } from "$lib/client/liveStatus.svelte";
  import GC from "$lib/global-constants";

  // G5: the page's overall status headline, following the live stream.
  //
  // **Its own component because the headline and the bars must not disagree.**
  // The bars are patched inside `MonitorList`, and the headline is rendered above
  // it by both public page components. Without this, a monitor going red would
  // turn its bar red while "All Systems Operational" sat above it until the
  // visitor reloaded - which is worse than not updating at all, because one of
  // the two is now confidently wrong.
  //
  // A component rather than the same three lines pasted into both pages, for the
  // reason `MonitorList` exists at all: the two page files are near-copies and a
  // change made to one silently misses the other.

  interface Props {
    /** The server-rendered status, correct at page load. */
    statusClass: string;
    statusText: string;
  }

  let { statusClass, statusText }: Props = $props();

  /**
   * The server's `statusBgClass`, restated here rather than imported.
   *
   * Two reasons, both hard. It lives in `$lib/server/incidents/pageStatus.ts`,
   * and importing a server module into a component drags it into the browser
   * bundle - the same direction that file's own header warns about. And the
   * classes have to be *written out*: `bg-${status.toLowerCase()}` is invisible
   * to Tailwind's scanner, so the styles would simply not be generated.
   */
  function bgClass(status: string): string {
    switch (status) {
      case GC.DOWN:
        return "bg-down";
      case GC.DEGRADED:
        return "bg-degraded";
      case GC.MAINTENANCE:
        return "bg-maintenance";
      case GC.UP:
        return "bg-up";
      default:
        return "bg-muted-foreground";
    }
  }

  // The live value only once one has arrived. Before that the server's own
  // derivation stands, which is the right answer for a page nothing has changed
  // on - and it means a stream that never connects changes nothing at all.
  const effectiveClass = $derived(liveStatus.pageStatus ? bgClass(liveStatus.pageStatus.status) : statusClass);
  const effectiveText = $derived(liveStatus.pageStatus?.status_summary || statusText);
</script>

<EventsCard statusClass={effectiveClass} statusText={effectiveText} />
