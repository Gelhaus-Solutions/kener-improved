---
title: Site Configuration
description: Configure core site settings and understand where they affect runtime behavior
---

Use **Manage → Site Configurations** to control identity, navigation, monitor sharing controls, page visibility behavior, retention, and event visibility.

## Quick setup {#quick-setup}

1. Open **Manage → Site Configurations**.
2. Save **Site Information** (`siteName`, `siteURL`, logo, favicon).
3. Configure **Navigation Menu**.
4. Set **Monitor Sub Menu Options**.
5. Configure **Global Page Visibility Settings**.
6. Configure **Social Preview & SEO**.
7. Configure **Data Retention Policy**.
8. Configure **Event Display Settings**.
9. Configure **Maintenance Notification Settings**.

## Runtime impact map {#runtime-impact-map}

| Setting area                 | Stored key                                                   | Runtime impact                                                                                  |
| ---------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Site name / URL / logo / nav | `siteName`, `siteURL`, `logo`, `nav`                         | Rendered in top navbar branding and nav links                                                   |
| Favicon                      | `favicon`                                                    | Used in `<head>` as page icon                                                                   |
| Monitor sub menu options     | `subMenuOptions`                                             | Gates monitor share actions (badges/embed) on public monitor pages                              |
| Global page visibility       | `globalPageVisibilitySettings`                               | Controls page switcher visibility and page-scoped navigation/events                             |
| Data retention policy        | `dataRetentionPolicy`                                        | Controls daily cleanup of `monitoring_data` and each rollup grain                               |
| Event display settings       | `eventDisplaySettings`                                       | Controls event visibility and whether events render inline or in the notification surface       |
| Maintenance notifications    | `globalMaintenanceNotificationSettings`                      | Controls which maintenance lifecycle events notify subscribers and reminder buffer timing       |
| Social preview & SEO         | `metaSiteTitle`, `metaSiteDescription`, `socialPreviewImage` | Default `<title>`, `og:title`, `<meta description>`, `og:description`, `og:image` for all pages |

## Monitor sub menu options {#monitor-sub-menu-options}

These site-level flags control share actions globally:

- `showShareBadgeMonitor`
- `showShareEmbedMonitor`

> [!IMPORTANT]
> These site-level toggles are combined with monitor-level sharing options. If site-level is disabled, monitor-level cannot force it on.

See [Sharing Monitors](/docs/v4/sharing).

## Global page visibility settings {#global-page-visibility-settings}

`globalPageVisibilitySettings` has two flags:

- `showSwitcher: boolean`
    - Controls whether the page switcher dropdown is visible in the top controls.
    - `true`: users can switch pages from the selector.
    - `false`: page selector is hidden.

- `forceExclusivity: boolean`
    - Enables page-scoped behavior for navigation/events.
    - In the dashboard UI, enabling this automatically sets `showSwitcher` to `true` and locks it as read-only.
    - Runtime effects:
        - navbar brand/logo click resolves to the current page path (`/{page_path}`) instead of global root,
        - notifications calendar link resolves to page-scoped events (`/{page_path}/events/{MMMM-yyyy}`),
        - events-by-month API is filtered to monitors assigned to that page (global incidents/maintenances still appear).

> [!IMPORTANT]
> `forceExclusivity` takes precedence over `showSwitcher` behavior for page-scoped navigation/event flows.

See [Pages](/docs/v4/pages).

## Data retention policy {#data-retention-policy}

`dataRetentionPolicy` drives the daily cleanup scheduler, which runs at midnight UTC and prunes raw samples and each rollup grain separately:

| Field                   | Default | Keeps                                               |
| ----------------------- | ------- | --------------------------------------------------- |
| `enabled`               | `true`  | Turns cleanup on or off                             |
| `retentionDays`         | `90`    | Raw per-minute samples. Minimum 7 days              |
| `rollup5mRetentionDays` | `400`   | 5-minute buckets. `0` keeps them forever            |
| `rollup1hRetentionDays` | `1095`  | Hourly buckets. `0` keeps them forever              |
| `rollup1dRetentionDays` | `0`     | Daily buckets. `0` (the default) keeps them forever |

Uptime bars are served from the rollups, not from raw samples, so `retentionDays` can be much shorter than the history your pages display. Raw samples are still needed for the last few minutes of every bar, for alert evaluation and for incident metrics, which is why 7 days is the enforced minimum.

### How long a bar can be {#retention-bar-length}

A viewer's day boundaries are offset by their timezone, and only a bucket size that divides that offset can be used. That makes the answer differ per viewer:

- **Every timezone** is bounded by `rollup5mRetentionDays` — India (+05:30) and Nepal (+05:45) need 5-minute buckets.
- **Whole-hour offsets** are bounded by `rollup1hRetentionDays`.
- **UTC** is bounded by `rollup1dRetentionDays`.

**Manage → Site Configurations** shows all three, and warns when a page is configured to display more history than retention keeps.

> [!IMPORTANT]
> Raw samples are only deleted once the rollups computed from them are complete and have passed the cutoff. If the rollup scheduler is behind, the raw stage is skipped and the reason is logged rather than history being destroyed.

Run `npm run retention:plan` to print what the next sweep would delete without deleting anything.

## Event display settings {#event-display-settings}

`eventDisplaySettings` controls which events are visible:

- `showInlineEvents`: when `true`, ongoing/upcoming events render inline on status pages; when `false` (default), they are shown through the notification UI.
- incidents: ongoing/resolved + resolved limits
- maintenances: ongoing/past/upcoming + limits

This affects:

- event sections on status pages
- notification UI visibility and payloads used by the UI

## Maintenance notification settings {#maintenance-notification-settings}

`globalMaintenanceNotificationSettings` controls which maintenance event lifecycle transitions send subscriber notifications.

### Event types {#event-types}

| Event type | Trigger                         | Default |
| ---------- | ------------------------------- | ------- |
| `created`  | New maintenance event generated | Off     |
| `reminder` | Event enters READY state        | On      |
| `started`  | Event enters ONGOING state      | On      |
| `ended`    | Event enters COMPLETED state    | On      |

### Reminder buffer {#reminder-buffer}

`reminder_buffer_hours` (default `1`, minimum `1`) sets how many hours before the event start time the status transitions from SCHEDULED to READY.

See [Maintenance Events → Subscriber Notifications](/docs/v4/maintenances/events#subscriber-notifications) for the full lifecycle flow.

## Social preview and SEO {#social-preview-and-seo}

The **Social Preview & SEO** card sets site-wide defaults for meta tags used in search engines and link previews.

| Field                  | Stored key            | Meta tags affected                            |
| ---------------------- | --------------------- | --------------------------------------------- |
| `Meta Title`           | `metaSiteTitle`       | `<title>`, `og:title`                         |
| `Meta Description`     | `metaSiteDescription` | `<meta name="description">`, `og:description` |
| `Social Preview Image` | `socialPreviewImage`  | `og:image`, `twitter:image`                   |

These values are used as defaults for every page. Individual pages can override them — see [Pages → Social Preview & SEO](/docs/v4/pages#social-preview-and-seo).

> [!TIP]
> Upload a 1200×630 image for best results across social platforms.

## Verify changes {#verify-changes}

- Update site name/logo/nav and refresh home page.
- Toggle monitor share options and verify Badge/Embed actions on a monitor page.
- Toggle `showSwitcher` and verify the page selector appears/disappears.
- Enable `forceExclusivity` and verify:
    - brand link stays within current page path,
    - notifications calendar opens page-scoped events for the current month.
- Change event display settings and verify inline events vs notification UI behavior.
- Set retention policy and confirm scheduler logs in server output.
- Toggle maintenance notification event types and verify subscribers receive (or don't receive) emails at each lifecycle stage.
- Set meta title/description and social preview image, then check `<meta>` tags in page source.
