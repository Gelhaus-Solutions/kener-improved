<script lang="ts">
  import SectionTabs from "../../section-tabs.svelte";
  import { canReachRoute, routeIdForManageUrl } from "$lib/routePermissions.js";

  let { children, data } = $props();

  const allTabs = [
    { title: "General", url: "/manage/app/site-configurations" },
    { title: "Analytics", url: "/manage/app/site-configurations/analytics-providers" },
    { title: "Captcha", url: "/manage/app/site-configurations/captcha-providers" }
  ];

  const tabs = allTabs.filter((tab) => canReachRoute(data.userPermissions, routeIdForManageUrl(tab.url)));
</script>

<div class="flex w-full flex-col">
  <SectionTabs {tabs} />
  {@render children()}
</div>
