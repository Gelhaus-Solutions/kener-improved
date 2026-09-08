<script lang="ts">
  import SectionTabs from "../../section-tabs.svelte";
  import { canReachRoute, routeIdForManageUrl } from "$lib/routePermissions.js";

  let { children, data } = $props();

  const allTabs = [
    { title: "Endpoints", url: "/manage/app/webhooks" },
    { title: "Delivery Log", url: "/manage/app/webhooks/deliveries" },
    { title: "Event Bus", url: "/manage/app/webhooks/event-consumers" }
  ];

  const tabs = allTabs.filter((tab) => canReachRoute(data.userPermissions, routeIdForManageUrl(tab.url)));
</script>

<div class="flex w-full flex-col">
  <SectionTabs {tabs} />
  {@render children()}
</div>
