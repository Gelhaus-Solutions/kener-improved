<script lang="ts">
  import SectionTabs from "../../section-tabs.svelte";
  import { canReachRoute, routeIdForManageUrl } from "$lib/routePermissions.js";

  let { children, data } = $props();

  const allTabs = [
    { title: "Badges", url: "/manage/app/share/badges" },
    { title: "Embed", url: "/manage/app/share/embed" }
  ];

  const tabs = allTabs.filter((tab) => canReachRoute(data.userPermissions, routeIdForManageUrl(tab.url)));
</script>

<div class="flex w-full flex-col">
  <SectionTabs {tabs} />
  {@render children()}
</div>
