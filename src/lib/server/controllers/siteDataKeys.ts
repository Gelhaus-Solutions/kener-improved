import {
  IsValidAnalytics,
  IsValidConsumerModes,
  IsValidMfaPolicy,
  IsValidColors,
  IsValidHero,
  IsValidI18n,
  IsValidJSONArray,
  IsValidJSONString,
  IsValidNav,
  IsValidURL,
} from "./validators.js";

interface SiteDataKey {
  key: string;
  isValid: (value: string) => boolean;
  data_type: string;
}

/**
 * A retention policy: a boolean, a positive raw retention, and three optional
 * non-negative rollup retentions where 0 means forever.
 *
 * Deliberately does NOT enforce the raw floor or the ordering between grains.
 * Those are applied when the policy is *used* (`services/retention.ts`), so an
 * operator who saves something unwise gets it clamped and reported rather than a
 * rejected form telling them nothing about what the safe value is.
 */
function IsValidDataRetentionPolicy(value: string): boolean {
  if (!IsValidJSONString(value)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const policy = parsed as Record<string, unknown>;
  if (typeof policy.enabled !== "boolean") return false;
  if (!Number.isFinite(Number(policy.retentionDays)) || Number(policy.retentionDays) < 1) return false;
  for (const key of [
    "rollup5mRetentionDays",
    "rollup15mRetentionDays",
    "rollup1hRetentionDays",
    "rollup1dRetentionDays",
  ]) {
    if (policy[key] === undefined || policy[key] === null) continue;
    const days = Number(policy[key]);
    if (!Number.isFinite(days) || days < 0) return false;
  }
  return true;
}

/**
 * The instance-wide latency threshold (B5).
 *
 * Shape enforced here rather than left to `parseThreshold`, which falls back
 * field by field and so cannot reject anything. The one rule it genuinely
 * cannot express is the ordering: `down_ms` below `degraded_ms` describes a
 * monitor that goes DOWN before it ever goes DEGRADED, which is not a
 * conservative reading of a badly written rule, it is a rule that can never
 * produce DEGRADED at all. The screen checks it too; this is the check that
 * still holds for the v4 config API and for anything writing by hand.
 *
 * `down_ms` is nullable on purpose and null is meaningful: latency alone can
 * never make this monitor DOWN.
 */
function IsValidLatencyThreshold(value: string): boolean {
  if (!IsValidJSONString(value)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const rule = parsed as Record<string, unknown>;
  if (typeof rule.enabled !== "boolean") return false;
  if (!["p50", "p90", "p95", "p99", "avg"].includes(String(rule.metric))) return false;
  for (const key of ["window_minutes", "min_samples", "degraded_ms"]) {
    const n = Number(rule[key]);
    if (!Number.isFinite(n) || n <= 0) return false;
  }
  if (rule.down_ms !== undefined && rule.down_ms !== null) {
    const down = Number(rule.down_ms);
    if (!Number.isFinite(down) || down <= 0) return false;
    if (down <= Number(rule.degraded_ms)) return false;
  }
  return true;
}

/**
 * The instance-wide probe merge defaults (B1d).
 *
 * The enum fields are the point of validating at all. `parseMergeDefaults`
 * falls back field by field, so an unrecognised policy is silently replaced by
 * the default at read time - which means a typo here would leave the screen
 * showing what was saved while the merge ran on something else entirely.
 */
function IsValidProbeMergePolicy(value: string): boolean {
  if (!IsValidJSONString(value)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const config = parsed as Record<string, unknown>;
  if (!["TRUST_ORDER", "WEIGHTED_MAJORITY", "QUORUM_DOWN"].includes(String(config.policy))) return false;
  for (const key of ["defaultMode", "localMode"]) {
    if (!["VOTE", "DISPLAY_ONLY", "OFF"].includes(String(config[key]))) return false;
  }
  if (typeof config.degradedOnDisagreement !== "boolean") return false;
  const quorum = Number(config.quorumThreshold);
  if (!Number.isFinite(quorum) || quorum < 1) return false;
  // Weights may be 0 ("this source cannot carry a vote"); ranks may be 0 too,
  // since lower is more trusted and 0 is simply the most trusted.
  for (const key of ["defaultWeight", "localWeight", "defaultTrustRank", "localTrustRank"]) {
    const n = Number(config[key]);
    if (!Number.isFinite(n) || n < 0) return false;
  }
  return true;
}

export const siteDataKeys: SiteDataKey[] = [
  {
    key: "title",
    isValid: (value) => typeof value === "string" && value.trim().length > 0,
    data_type: "string",
  },
  {
    key: "siteName",
    isValid: (value) => typeof value === "string" && value.trim().length > 0,
    data_type: "string",
  },
  {
    key: "siteURL",
    isValid: IsValidURL,
    data_type: "string",
  },
  {
    key: "homeDataMaxDays",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "home",
    isValid: (value) => typeof value === "string" && value.trim().length > 0,
    data_type: "string",
  },
  {
    key: "favicon",
    isValid: (value) => typeof value === "string",
    data_type: "string",
  },
  {
    key: "logo",
    isValid: (value) => typeof value === "string",
    data_type: "string",
  },
  {
    key: "metaTags",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "nav",
    isValid: IsValidNav,
    data_type: "object",
  },
  {
    key: "hero",
    isValid: IsValidHero,
    data_type: "object",
  },
  {
    key: "footerHTML",
    isValid: (value) => typeof value === "string",
    data_type: "string",
  },
  {
    key: "kenerTheme",
    isValid: (value) => typeof value === "string",
    data_type: "string",
  },
  {
    key: "customCSS",
    isValid: (value) => typeof value === "string",
    data_type: "string",
  },
  {
    key: "i18n",
    isValid: IsValidI18n,
    data_type: "object",
  },
  {
    key: "pattern",
    //string dots or squares or circle
    isValid: (value) =>
      typeof value === "string" &&
      [
        "dots",
        "squares",
        "tiles",
        "none",
        "radial-blue",
        "radial-mono",
        "radial-midnight",
        "circle-mono",
        "carbon-fibre",
        "texture-sky",
        "angular-mono",
        "angular-spring",
        "angular-bloom",
        "pets",
      ].includes(value),
    data_type: "string",
  },
  {
    key: "analytics",
    isValid: IsValidAnalytics,
    data_type: "object",
  },
  {
    key: "theme",
    //light dark system none
    isValid: (value) => typeof value === "string" && ["light", "dark", "system", "none"].includes(value),
    data_type: "string",
  },
  {
    key: "themeToggle",
    //boolean
    isValid: (value) => typeof value === "string",
    data_type: "string",
  },
  {
    key: "tzToggle",
    //boolean
    isValid: (value) => typeof value === "string",
    data_type: "string",
  },
  {
    key: "showSiteStatus",
    //boolean
    isValid: (value) => typeof value === "string",
    data_type: "string",
  },
  {
    key: "barStyle",
    //PARTIAL or FULL
    isValid: (value) => typeof value === "string" && ["PARTIAL", "FULL"].includes(value),
    data_type: "string",
  },
  {
    key: "barRoundness",
    //SHARP or ROUNDED
    isValid: (value) => typeof value === "string" && ["SHARP", "ROUNDED"].includes(value),
    data_type: "string",
  },
  {
    key: "summaryStyle",
    //CURRENT or DAY
    isValid: (value) => typeof value === "string" && ["CURRENT", "DAY"].includes(value),
    data_type: "string",
  },
  {
    key: "colors",
    isValid: IsValidColors,
    data_type: "object",
  },
  {
    key: "colorsDark",
    isValid: IsValidColors,
    data_type: "object",
  },
  {
    key: "font",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "monitorSort",
    isValid: IsValidJSONArray,
    data_type: "object",
  },
  {
    key: "categories",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "homeIncidentCount",
    isValid: (value) => parseInt(value) >= 0,
    data_type: "string",
  },
  {
    key: "homeIncidentStartTimeWithin",
    isValid: (value) => parseInt(value) >= 1,
    data_type: "string",
  },
  {
    key: "incidentGroupView",
    isValid: (value) => typeof value === "string" && value.trim().length > 0,
    data_type: "string",
  },
  {
    key: "analytics.googleTagManager",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "analytics.plausible",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "analytics.mixpanel",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "analytics.amplitude",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "analytics.clarity",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "analytics.umami",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "analytics.posthog",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "analytics.openpanel",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "captcha.hcaptcha",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "captcha.recaptcha",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "captcha.turnstile",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "subscriptionsSettings",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "subMenuOptions",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "announcement",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    // F6c: validated by shape rather than merely as JSON. The rollup grains are
    // what the uptime bar reads now, so a typo that stored a string here would
    // be a silent instruction to delete history - and `IsValidJSONString`
    // accepts every one of them.
    key: "dataRetentionPolicy",
    isValid: IsValidDataRetentionPolicy,
    data_type: "object",
  },
  {
    // Fork addition. Days of audit_log history to keep; pruned by dailyCleanup.
    key: "auditRetentionDays",
    isValid: (value: string) => Number.isFinite(Number(value)) && Number(value) >= 1,
    data_type: "string",
  },
  {
    key: "eventDisplaySettings",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "socialPreviewImage",
    isValid: (value) => typeof value === "string",
    data_type: "string",
  },
  {
    key: "globalPageVisibilitySettings",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "pageOrderingSettings",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "dateAndTimeFormat",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "metaSiteTitle",
    isValid: (value) => typeof value === "string",
    data_type: "string",
  },
  {
    key: "metaSiteDescription",
    isValid: (value) => typeof value === "string",
    data_type: "string",
  },
  {
    key: "sitemap",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "globalMaintenanceNotificationSettings",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    key: "oidcSettings",
    isValid: IsValidJSONString,
    data_type: "object",
  },
  {
    // What each event bus consumer is allowed to do. See
    // server/events/consumerModes.ts; written by the event consumers screen.
    //
    // Validated harder than the JSON-shaped keys around it, and deliberately so.
    // Every other key here decides how the site looks; this one decides whether
    // customer notifications are sent at all, and an unrecognised mode written
    // by hand would be dropped silently at read time. Rejecting it at the write
    // is the difference between a clear error and a channel that quietly stopped.
    key: "eventBusConsumers",
    isValid: IsValidConsumerModes,
    data_type: "object",
  },
  {
    // Who must hold a second factor: none | local_only | all. Defaults to
    // local_only, which exempts users who authenticate at an identity provider,
    // since their factors are the provider's business.
    key: "mfaPolicy",
    isValid: IsValidMfaPolicy,
    data_type: "string",
  },
  {
    // B5's instance-wide latency rule. Its absence from this list meant every
    // save from the Site Configurations screen threw "Invalid key" - the reader,
    // the cache invalidator and the whole form shipped, and the one line that
    // lets the value be written did not.
    key: "latencyThresholdDefault",
    isValid: IsValidLatencyThreshold,
    data_type: "object",
  },
  {
    // B1d's instance-wide merge defaults: how several observations of one
    // monitor become the one status the page publishes.
    //
    // Validated harder than a JSON-shaped key, on the same reasoning as
    // `eventBusConsumers` above: an unrecognised policy written by hand would
    // fall back to the default at read time and silently decide differently
    // from what the operator wrote. See `probes/merge.ts`.
    key: "probeMergePolicy",
    isValid: IsValidProbeMergePolicy,
    data_type: "object",
  },
];
