export interface SiteAnnouncement {
  title: string;
  message: string;
  type: "INFO" | "WARNING" | "ERROR";
  reshowAfterInHours: number | null;
  cancellable: boolean;
  ctaURL: string | null;
  ctaText: string | null;
}

export interface SiteMetaTag {
  key: string;
  value: string;
}

export interface SiteNavItem {
  name: string;
  url: string;
  iconURL: string;
}

export interface SiteHero {
  title: string;
  subtitle: string | null;
  image: string | null;
}

export interface SiteI18nLocale {
  code: string;
  name: string;
  selected: boolean;
  disabled: boolean;
}

export interface SiteI18nConfig {
  defaultLocale: string;
  locales: SiteI18nLocale[];
}

export interface SiteAnalyticsItem {
  id: string;
  type: string;
  name: string;
  script: string;
}

export interface SiteStatusColors {
  UP: string;
  DOWN: string;
  DEGRADED: string;
  MAINTENANCE: string;
  ACCENT: string;
  ACCENT_FOREGROUND: string;
}

export interface SiteFont {
  cssSrc: string;
  family: string;
}

export interface SiteCategory {
  name: string;
  description: string;
  isHidden: boolean;
  image: string | null;
}

export interface SiteHomeDataMaxDays {
  desktop: {
    maxDays: number;
    selectableDays: number[];
  };
  mobile: {
    maxDays: number;
    selectableDays: number[];
  };
}

export interface SiteSubscriptionsSettings {
  enable: boolean;
  methods: {
    emails: {
      incidents: boolean;
      maintenance: boolean;
    };
  };
}

export interface SiteSubMenuOptions {
  showShareBadgeMonitor: boolean;
  showShareEmbedMonitor: boolean;
  showRssFeed: boolean;
}

/**
 * How long each grain of monitoring history is kept (F6c).
 *
 * `retentionDays` is the raw `monitoring_data` table; the three rollup fields
 * are the grains that outlive it. **0 means forever** on the rollup fields, and
 * is the default for daily buckets - a decade of them for a thousand monitors is
 * a few million rows, which is not worth throwing history away for.
 *
 * The point of the split: the bar no longer reads raw samples, so raw retention
 * can drop to weeks while the 90- or 365-day bar keeps being served from the
 * hourly and daily grains.
 */
export interface DataRetentionPolicy {
  enabled: boolean;
  /** Raw `monitoring_data`. Floored at `MIN_RAW_RETENTION_DAYS`; see `services/retention.ts`. */
  retentionDays: number;
  /** Five-minute buckets. The finest grain, and the fallback when nothing coarser fits. */
  rollup5mRetentionDays?: number;
  /**
   * Quarter-hour buckets. Serves viewers on :30 and :45 timezone offsets
   * (KENER-124), which is what the 5m grain used to be doing for them at three
   * times the rows.
   */
  rollup15mRetentionDays?: number;
  /** Hourly buckets. Serves every whole-hour offset, which is most viewers. */
  rollup1hRetentionDays?: number;
  /** Daily buckets. 0 = forever, and that is the default. */
  rollup1dRetentionDays?: number;
}

export interface EventDisplaySettings {
  showInlineEvents: boolean;
  incidents: {
    enabled: boolean;
    ongoing: {
      show: boolean;
    };
    resolved: {
      show: boolean;
      maxCount: number;
      daysInPast: number;
    };
  };
  maintenances: {
    enabled: boolean;
    ongoing: {
      show: boolean;
    };
    past: {
      show: boolean;
      maxCount: number;
      daysInPast: number;
    };
    upcoming: {
      show: boolean;
      maxCount: number;
      daysInFuture: number;
    };
  };
}

export interface GlobalPageVisibilitySettings {
  showSwitcher: boolean;
  forceExclusivity: boolean;
}

export interface PageOrderingSettings {
  enabled: boolean;
  order: number[]; // Array of page IDs in the desired order
}

export interface SiteDateTimeFormat {
  datePlusTime: string;
  dateOnly: string;
  timeOnly: string;
}

export interface SitemapXMLConfig {
  mode: "auto" | "manual" | "off";
  urls: {
    loc: string;
  }[];
}

export interface GlobalMaintenanceNotificationSettings {
  event_types: {
    created: boolean;
    reminder: boolean;
    started: boolean;
    ended: boolean;
  };
  reminder_buffer_hours: number;
}

export interface OidcSettings {
  enabled: boolean;
  provider_name: string;
  issuer_url: string;
  client_id: string;
  client_secret: string;
  scopes: string;
  groups_claim: string;
  allow_local_login: boolean;
  auto_create_users: boolean;
  default_role_id: string;
}

export interface OidcGroupRoleMapping {
  id?: number;
  oidc_group: string;
  role_id: string;
  created_at?: Date;
  updated_at?: Date;
}
