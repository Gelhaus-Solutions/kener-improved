<script lang="ts">
  import "../layout.css";
  import "../kener.css";
  import "../manage.css";
  import { ModeWatcher } from "mode-watcher";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import BlendIcon from "@lucide/svelte/icons/blend";
  import TargetIcon from "@lucide/svelte/icons/target";
  import FileChartColumnIcon from "@lucide/svelte/icons/file-chart-column";
  import MailboxIcon from "@lucide/svelte/icons/mailbox";
  import AppSidebar from "./manage/app-sidebar.svelte";
  import Settings2Icon from "@lucide/svelte/icons/settings-2";
  import GlobeIcon from "@lucide/svelte/icons/globe";
  import SirenIcon from "@lucide/svelte/icons/siren";
  import BellIcon from "@lucide/svelte/icons/bell";
  import CodeIcon from "@lucide/svelte/icons/code";
  import CloudAlertIcon from "@lucide/svelte/icons/cloud-alert";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import ClockAlertIcon from "@lucide/svelte/icons/clock-alert";
  import BookOpenIcon from "@lucide/svelte/icons/book-open";
  import KeyIcon from "@lucide/svelte/icons/key";
  import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
  import WebhookIcon from "@lucide/svelte/icons/webhook";
  import UsersIcon from "@lucide/svelte/icons/users";
  import ShieldIcon from "@lucide/svelte/icons/shield";
  import FingerprintIcon from "@lucide/svelte/icons/fingerprint";
  import Columns3CogIcon from "@lucide/svelte/icons/columns-3-cog";
  import TagsIcon from "@lucide/svelte/icons/tags";
  import SiteHeader from "./manage/site-header.svelte";
  import TemplateIcon from "@lucide/svelte/icons/layout-template";
  import clientResolver from "$lib/client/resolver.js";
  import DatabaseIcon from "@lucide/svelte/icons/database";
  import Building2Icon from "@lucide/svelte/icons/building-2";
  import ServerCogIcon from "@lucide/svelte/icons/server-cog";
  import RadarIcon from "@lucide/svelte/icons/radar";

  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import { canReachRoute, routeIdForManageUrl } from "$lib/routePermissions.js";

  let { children, data } = $props();

  // Navigation - single source of truth.
  //
  // I3f: grouped rather than flat. The old list was 24 entries in the order
  // screens happened to be built, so Alerts and Triggers sat five apart though
  // one fires the other, and the screens used during an outage were below five
  // configuration screens nobody opens twice a year. Order within a group is
  // what an operator reaches for, most often first.
  //
  // Some entries now cover several screens. Analytics and Captcha are tabs on
  // Site Configurations, Badges and Embed are tabs on Share, and the Delivery
  // Log and Event Bus are tabs on Webhooks. The routes moved with them; the old
  // paths 308 to the new ones, see `manageRedirects.ts`.
  const allNavGroups = [
    {
      title: "Operate",
      items: [
        { title: "Monitors", url: "/manage/app/monitors", icon: BlendIcon },
        { title: "Incidents", url: "/manage/app/incidents", icon: CloudAlertIcon },
        // C4. Beside Incidents rather than nested under it: an operator opening
        // an incident reaches a template through the create form, and the only
        // people who come here are the ones maintaining the templates themselves.
        { title: "Incident Templates", url: "/manage/app/incident-templates", icon: FileTextIcon },
        { title: "Maintenances", url: "/manage/app/maintenances", icon: ClockAlertIcon },
        { title: "Alerts", url: "/manage/app/alerts", icon: SirenIcon },
        { title: "Monitoring Data", url: "/manage/app/monitoring-data", icon: DatabaseIcon },
        // B1c. In Operate beside Monitoring Data rather than in Settings: an
        // operator comes here to see whether a region is still reporting, which
        // is something watched during a bad hour, not configured once.
        { title: "Probes", url: "/manage/app/probes", icon: RadarIcon },
        // F1a. In Operate rather than Settings: an error budget is something an
        // operator watches during a bad week, not a preference set once.
        { title: "SLOs", url: "/manage/app/slo", icon: TargetIcon },
        // F2. Beside SLOs, because the two answer the same question for two
        // audiences: the SLO screen is what an operator watches, a report is what
        // gets handed to the customer who asked about the same week.
        { title: "Reports", url: "/manage/app/reports", icon: FileChartColumnIcon }
      ]
    },
    {
      title: "Notify",
      items: [
        { title: "Subscriptions", url: "/manage/app/subscriptions", icon: BellIcon },
        { title: "Triggers", url: "/manage/app/triggers", icon: MailboxIcon },
        { title: "Templates", url: "/manage/app/templates", icon: TemplateIcon },
        {
          title: "Webhooks",
          url: "/manage/app/webhooks",
          icon: WebhookIcon,
          tabs: ["/manage/app/webhooks", "/manage/app/webhooks/deliveries", "/manage/app/webhooks/event-consumers"]
        }
      ]
    },
    {
      title: "Status page",
      items: [
        { title: "Pages", url: "/manage/app/pages", icon: BookOpenIcon },
        // Beside Pages rather than under Operate: a category is the section a
        // component sits in on a status page, so the people who come here are
        // laying out a page rather than responding to anything.
        { title: "Categories", url: "/manage/app/categories", icon: TagsIcon },
        { title: "Customizations", url: "/manage/app/customizations", icon: Columns3CogIcon },
        { title: "Internationalization", url: "/manage/app/internationalization", icon: GlobeIcon },
        {
          title: "Share",
          url: "/manage/app/share/badges",
          match: "/manage/app/share",
          icon: CodeIcon,
          tabs: ["/manage/app/share/badges", "/manage/app/share/embed"]
        }
      ]
    },
    {
      title: "Access",
      items: [
        { title: "Users", url: "/manage/app/users", icon: UsersIcon },
        { title: "Roles", url: "/manage/app/roles", icon: ShieldIcon },
        { title: "OpenID Connect", url: "/manage/app/oidc", icon: FingerprintIcon },
        { title: "API Keys", url: "/manage/app/api-keys", icon: KeyIcon },
        { title: "Organisations", url: "/manage/app/organisations", icon: Building2Icon },
        // KENER-31. The instance console. `instanceOnly` rather than a
        // permission, because no per-org permission can gate it: see
        // orgPerms.ts's SUPERADMIN_ROUTES and instanceController.ts. Filtered by
        // the same fact the route itself is gated on, so a tenant's
        // administrator is never shown a link that would 403.
        { title: "Instance", url: "/manage/app/instance", icon: ServerCogIcon, instanceOnly: true },
        { title: "Audit Log", url: "/manage/app/audit", icon: ScrollTextIcon }
      ]
    },
    {
      title: "Settings",
      items: [
        {
          title: "Site Configurations",
          url: "/manage/app/site-configurations",
          icon: Settings2Icon,
          tabs: [
            "/manage/app/site-configurations",
            "/manage/app/site-configurations/analytics-providers",
            "/manage/app/site-configurations/captcha-providers"
          ]
        }
      ]
    }
  ];

  // An entry that covers several tabs is shown when *any* of them is reachable,
  // and points at the first one that is. Without this, folding the Event Bus
  // into Webhooks would hide it outright from somebody holding `eventbus.read`
  // and not `webhooks.read`, which is a combination the permissions are
  // deliberately split to allow.
  function firstReachable(item: { url: string; tabs?: string[]; instanceOnly?: boolean }): string | undefined {
    // KENER-31. An instance-tier entry is not in the permission map at all, so
    // asking `canReachRoute` about it would always answer no. It is shown or
    // hidden by the one fact that gates the route itself.
    if (item.instanceOnly) return data.isInstanceSuperadmin ? item.url : undefined;
    return (item.tabs ?? [item.url]).find((url) => canReachRoute(data.userPermissions, routeIdForManageUrl(url)));
  }

  // A group whose every item is filtered out must not render an empty heading.
  //
  // `match` is the path that says whether an entry is the one being looked at.
  // It is the entry's own url for most of them, but a section whose first tab
  // sits below the section root needs the root: Share links to its Badges tab,
  // and must still light up while the Embed tab is open.
  const navGroups = allNavGroups
    .map((group) => ({
      ...group,
      items: group.items
        .map((item) => ({ item, url: firstReachable(item) }))
        .filter((entry) => entry.url !== undefined)
        .map(({ item, url }) => ({
          ...item,
          url: clientResolver(resolve, url as string),
          match: clientResolver(resolve, (item as { match?: string }).match ?? item.url)
        }))
    }))
    .filter((group) => group.items.length > 0);

  const navItems = navGroups.flatMap((group) => group.items);

  // Every screen the org switcher could land on, **unfiltered**: which of them
  // are reachable depends on the org being switched *to*, and the permissions for
  // that org only exist once the switch has happened. See org-switcher.svelte.
  // The instance console is excluded: it is the one screen that does not belong
  // to an org, so "which of these can I still see after switching" is not a
  // question it has an answer to (KENER-31).
  const navTargets = allNavGroups.flatMap((group) =>
    group.items
      .filter((item) => !(item as { instanceOnly?: boolean }).instanceOnly)
      .map((item) => ({
        section: (item as { match?: string }).match ?? item.url,
        urls: (item as { tabs?: string[] }).tabs ?? [item.url]
      }))
  );

  // Derive page title from current URL. Longest match wins, so a section's own
  // entry does not claim the title of a screen nested under it.
  //
  // `resolve()` hands back a path relative to the current page, so these have to
  // be resolved against it before they can be compared with an absolute
  // pathname. Without that every screen was titled "Dashboard".
  let pageTitle = $derived(
    navItems
      .map((item) => ({ ...item, path: new URL(item.match, page.url).pathname }))
      .filter((item) => page.url.pathname.startsWith(item.path))
      .sort((a, b) => b.path.length - a.path.length)[0]?.title || "Dashboard"
  );
</script>

<ModeWatcher defaultMode={data.defaultSiteTheme as "light" | "dark" | "system"} />
<Toaster />

<svelte:head>
  <meta name="robots" content="noindex, nofollow" />
  <title>{pageTitle} | Kener</title>
  <link rel="icon" href={clientResolver(resolve, "/logo96.png")} />
  {#if data.font?.cssSrc}
    <link rel="stylesheet" href={data.font.cssSrc} />
  {/if}
  {@html `
	<style>
		.kener-manage {
			--up: ${data.siteStatusColors.UP};
			--degraded: ${data.siteStatusColors.DEGRADED};
			--down: ${data.siteStatusColors.DOWN};
			--maintenance: ${data.siteStatusColors.MAINTENANCE};
			--accent: ${data.siteStatusColors.ACCENT || "#f4f4f5"};
			--accent-foreground: ${data.siteStatusColors.ACCENT_FOREGROUND || data.siteStatusColors.ACCENT || "#e96e2d"};
			${data.font?.family ? `--font-family:'${data.font.family}', sans-serif;` : ""}
		}
		:is(.dark) .kener-manage {
			--up: ${data.siteStatusColorsDark.UP};
			--degraded: ${data.siteStatusColorsDark.DEGRADED};
			--down: ${data.siteStatusColorsDark.DOWN};
			--maintenance: ${data.siteStatusColorsDark.MAINTENANCE};
			--accent: ${data.siteStatusColorsDark.ACCENT || "#27272a"};
			--accent-foreground: ${data.siteStatusColorsDark.ACCENT_FOREGROUND || data.siteStatusColorsDark.ACCENT || "#e96e2d"};
		}
	</style>`}
</svelte:head>
<main class="kener-manage">
  <Sidebar.Provider style="--sidebar-width: calc(var(--spacing) * 72); --header-height: calc(var(--spacing) * 12);">
    <AppSidebar variant="inset" {navGroups} {navTargets} />
    <Sidebar.Inset>
      <SiteHeader title={pageTitle} />
      <div class="p-4">
        <div class="@container/main flex flex-1">
          <Tooltip.Provider>
            {@render children()}
          </Tooltip.Provider>
        </div>
      </div>
    </Sidebar.Inset>
  </Sidebar.Provider>
</main>

<style>
  /* Apply the global font family using the CSS variable */
  * {
    font-family: var(--font-family);
  }
</style>
