import MobileDetect from "mobile-detect";
import type { Cookies } from "@sveltejs/kit";
import type { UserRecordPublic } from "$lib/server/types/db";
import seedSiteData from "$lib/server/db/seedSiteData";
import {
  GetAllSiteData,
  GetLoggedInSession,
  GetLocaleFromCookie,
  GetUsersCount,
  HasRequiredEnv,
  IsEmailSetup,
} from "./controller.js";
import type { EventDisplaySettings, GlobalPageVisibilitySettings, SiteDateTimeFormat } from "$lib/types/site.js";
import serverResolve from "../resolver.js";
import { GetSwitcherPages } from "./pagesController.js";
import { publicBaseUrlFromRequest } from "../http/publicUrl.js";
import type { PageNavItem } from "./dashboardController.js";

export interface LayoutServerData {
  isMobile: boolean;
  isSetupComplete: boolean;
  isAdminAccountCreated: boolean;
  loggedInUser: UserRecordPublic | null;
  selectedLang: string;
  siteStatusColors: {
    UP: string;
    DOWN: string;
    DEGRADED: string;
    MAINTENANCE: string;
    ACCENT: string;
    ACCENT_FOREGROUND: string;
  };
  siteStatusColorsDark: {
    UP: string;
    DOWN: string;
    DEGRADED: string;
    MAINTENANCE: string;
    ACCENT: string;
    ACCENT_FOREGROUND: string;
  };
  navItems: Array<{ name: string; url: string; iconURL: string }>;
  siteName: string;
  siteUrl: string;
  logo: string | undefined;
  favicon: string | undefined;
  footerHTML: string;
  isSubsEnabled: boolean;
  languageSetting: {
    defaultLocale: string;
    locales: Array<{ code: string; name: string; selected: boolean; disabled: boolean }>;
  };
  subMenuOptions: {
    showShareBadgeMonitor: boolean;
    showShareEmbedMonitor: boolean;
    showRssFeed: boolean;
  };
  isTimezoneEnabled: boolean;
  isThemeToggleEnabled: boolean;
  defaultSiteTheme: string;
  font: {
    cssSrc: string;
    family: string;
  };
  canSendEmail: boolean;
  announcement?: {
    title: string;
    message: string;
    type: "INFO" | "WARNING" | "ERROR";
    reshowAfterInHours: number | null;
    cancellable: boolean;
    ctaURL: string | null;
    ctaText: string | null;
  };
  eventDisplaySettings: EventDisplaySettings;
  socialPreviewImage?: string;
  customCSS?: string;
  globalPageVisibilitySettings: GlobalPageVisibilitySettings;
  /**
   * The pages the switcher may list, already ordered and filtered (G3).
   *
   * Here rather than fetched by the component. `PageSelector` used to call
   * `/dashboard-apis/pages` on mount, which cost every visitor an extra request
   * and a spinner for a list the server already had in hand. This layout load is
   * cached by I1, so carrying it costs nothing per request and the switcher
   * renders server-side with its current page already selected.
   */
  switcherPages: PageNavItem[];
  dateAndTimeFormat: SiteDateTimeFormat;
  metaSiteTitle?: string;
  metaSiteDescription?: string;
}

function NormalizeEventDisplaySettings(settings?: Partial<EventDisplaySettings>): EventDisplaySettings {
  const defaults = structuredClone(seedSiteData.eventDisplaySettings);

  return {
    showInlineEvents:
      typeof settings?.showInlineEvents === "boolean" ? settings.showInlineEvents : defaults.showInlineEvents,
    incidents: {
      ...defaults.incidents,
      ...settings?.incidents,
      ongoing: {
        ...defaults.incidents.ongoing,
        ...settings?.incidents?.ongoing,
      },
      resolved: {
        ...defaults.incidents.resolved,
        ...settings?.incidents?.resolved,
      },
    },
    maintenances: {
      ...defaults.maintenances,
      ...settings?.maintenances,
      ongoing: {
        ...defaults.maintenances.ongoing,
        ...settings?.maintenances?.ongoing,
      },
      past: {
        ...defaults.maintenances.past,
        ...settings?.maintenances?.past,
      },
      upcoming: {
        ...defaults.maintenances.upcoming,
        ...settings?.maintenances?.upcoming,
      },
    },
  };
}

export async function GetLayoutServerData(cookies: Cookies, request: Request): Promise<LayoutServerData> {
  const userAgent = request.headers.get("user-agent") ?? "";
  const md = new MobileDetect(userAgent);
  const isMobile = !!md.mobile();

  const [loggedInUser, siteData, userCounts, switcherPages] = await Promise.all([
    GetLoggedInSession(cookies),
    GetAllSiteData(),
    GetUsersCount(),
    // Org-scoped through `BaseRepository.table()`, using the org the request
    // pipeline already established from the hostname. See GetSwitcherPages.
    GetSwitcherPages(),
  ]);

  // Same check as IsSetupComplete, but reuses the site data fetched above
  // instead of querying it a second time on every request
  const isSetupComplete = HasRequiredEnv() && Object.keys(siteData).length > 0;

  const selectedLang = GetLocaleFromCookie(siteData, cookies);
  const siteStatusColors = siteData.colors;

  const siteStatusColorsDark = siteData.colorsDark || siteStatusColors;

  // Check if subscription is enabled
  let isSubsEnabled = false;
  const subsSetting = siteData.subscriptionsSettings;
  if (
    subsSetting &&
    subsSetting.enable &&
    (subsSetting.methods.emails.incidents || subsSetting.methods.emails.maintenance)
  ) {
    isSubsEnabled = true;
  }

  const languageSetting = {
    ...(siteData.i18n || seedSiteData.i18n),
    locales: (siteData.i18n?.locales || seedSiteData.i18n.locales).filter((l) => l.selected).map((l) => ({ ...l })),
  };
  const isTimezoneEnabled = !!siteData.tzToggle && siteData.tzToggle !== "NO";
  const isThemeToggleEnabled = !!siteData.themeToggle && siteData.themeToggle !== "NO";
  const defaultSiteTheme = siteData.theme || "system";
  const font = siteData.font || { cssSrc: "", family: "" };
  const canSendEmail = IsEmailSetup();
  return {
    isMobile,
    isSetupComplete,
    isAdminAccountCreated: userCounts ? Number(userCounts.count) > 0 : false,
    loggedInUser,
    selectedLang,
    siteStatusColors,
    siteStatusColorsDark,
    navItems: siteData.nav || [],
    siteName: siteData.siteName || "Kener",
    // G4. Host-derived, so `og:image` and friends point at the domain the
    // visitor is actually on. A social preview whose image URL is another domain
    // is fetched cross-origin by every scraper and is often simply dropped.
    siteUrl: publicBaseUrlFromRequest(request, siteData.siteURL) ?? "",
    logo: siteData.logo,
    // Browsers fetch <link rel="icon"> from the SSR HTML before hydration.
    // SvelteKit's resolve() uses a relative base on the app-root page, so
    // prefix KENER_BASE_PATH here instead of in the layout.
    favicon: siteData.favicon ? serverResolve(siteData.favicon) : siteData.favicon,
    footerHTML: siteData.footerHTML || "",
    isSubsEnabled,
    languageSetting,
    subMenuOptions: siteData.subMenuOptions || seedSiteData.subMenuOptions,
    isTimezoneEnabled,
    isThemeToggleEnabled,
    defaultSiteTheme,
    font,
    canSendEmail,
    announcement: siteData.announcement,
    eventDisplaySettings: NormalizeEventDisplaySettings(siteData.eventDisplaySettings),
    socialPreviewImage: siteData.socialPreviewImage,
    customCSS: siteData.customCSS,
    globalPageVisibilitySettings: siteData.globalPageVisibilitySettings || seedSiteData.globalPageVisibilitySettings,
    switcherPages,
    dateAndTimeFormat: siteData.dateAndTimeFormat || seedSiteData.dateAndTimeFormat,
    metaSiteTitle: siteData.metaSiteTitle,
    metaSiteDescription: siteData.metaSiteDescription,
  };
}
