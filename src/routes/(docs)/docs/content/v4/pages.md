---
title: Pages
description: Create and configure status pages, monitor visibility, and display preferences
---

Use Pages to create separate status views (for example: `home`, `services`, or `infrastructure`) and control which monitors appear on each page.

## Create a page {#create-a-page}

1. Open **Manage → Pages**.
2. Click **New Page**.
3. Fill required fields:
    - **Path** (URL segment)
    - **Title**
    - **Header**
4. Click **Create Page**.

> [!NOTE]
> The page path is automatically sanitized to a URL-friendly value (lowercase, spaces become `-`).

> [!IMPORTANT]
> The default home page (`/`) is created by default. You cannot change its path and you cannot delete it.

## General information fields {#general-information-fields}

| Field          | Required | Description                                     |
| -------------- | -------- | ----------------------------------------------- |
| `Path`         | Yes      | URL path for the page (for example `services`). |
| `Title`        | Yes      | Browser tab title.                              |
| `Header`       | Yes      | Main heading shown on the status page.          |
| `Page Content` | No       | Markdown content shown under the header.        |
| `Page Logo`    | No       | Optional logo image for the page.               |

## Add monitors to a page {#add-monitors-to-a-page}

In **Page Monitors**:

1. Select a monitor from the dropdown.
2. Click **Add**.
3. Repeat for all monitors you want on this page.

Remove a monitor by clicking the remove button next to it.

> [!IMPORTANT]
> Only monitors added to a page are shown on that page.

## Display settings {#display-settings}

Each page has its own display preferences.

### Monitor status history days {#monitor-status-history-days}

- **Desktop days**: how many days of status history to show on desktop.
- **Mobile days**: how many days of status history to show on mobile.

### Monitor layout style {#monitor-layout-style}

Choose one layout:

- `default-list`
- `default-grid`
- `compact-list`
- `compact-grid`

### Status filter {#status-filter}

Turn on **Status Filter** to show filter chips above the components, so visitors can narrow the page to everything that is `DOWN`, `DEGRADED`, and so on.

- Off by default. Existing pages are unchanged until you turn it on.
- Filtering happens in the browser and issues no extra requests.
- The chosen status is kept in the URL (`?status=DOWN`), so a filtered view can be shared during an incident.
- Chips appear only when the page has more than one status, so a healthy page shows no control at all.

### Component grouping {#component-grouping}

Set **Component Grouping** to `Group by category` to collect components into collapsible sections using each monitor's category.

- Sections appear in the order their monitors appear on the page, not alphabetically, so your monitor ordering is preserved.
- Components with no category are collected into a final **Other** section.
- **Start collapsed**: sections are closed on first load.
- **Show section status**: each section header shows the worst status among its components.

> [!NOTE]
> A category section is a visual grouping only. It is not the same as a [Group monitor](/docs/v4/monitors), which is a component with a status of its own. A Group monitor appears as a normal component inside whichever category it belongs to.

### Show in page switcher {#show-in-page-switcher}

Controls whether this page is listed in the switcher shown on public pages. On by default.

> [!IMPORTANT]
> This affects navigation only. Turning it off does not make the page private: it stays reachable at its own address and anyone with the link can open it.

Enable the switcher itself site-wide with `showSwitcher` in [Site Configuration](/docs/v4/setup/site-configuration), and order its entries with `pageOrderingSettings`.

Click **Save Preferences** after changes.

## Social preview and SEO {#social-preview-and-seo}

Each page can override the site-level SEO defaults set in [Site Configuration](/docs/v4/setup/site-configuration#social-preview-and-seo).

| Field                  | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `Meta Title`           | Custom `<title>` and `og:title` for this page.                |
| `Meta Description`     | Custom `<meta name="description">` and `og:description`.      |
| `Social Preview Image` | Custom `og:image` and `twitter:image` shown in link previews. |

When a field is left empty, the site-level value is used. When the site-level value is also empty, the page title and header are used as automatic fallbacks.

**Override hierarchy**: Page setting → Site setting → Auto-generated from page title/header.

> [!TIP]
> Upload a 1200×630 image for best results across social platforms.

## Delete a page {#delete-a-page}

Non-home pages can be deleted from **Danger Zone**.

To confirm deletion, type:

```text
delete <page_path>
```

Example:

```text
delete services
```

## Manage pages via API {#manage-pages-via-api}

Pages support full CRUD through the v4 REST API (`/api/v4/pages`), including assigning monitors. The home page has an empty stored path, so the API addresses it with the special segment `~home` (for example `PATCH /api/v4/pages/~home`); its path cannot be changed and it cannot be deleted. See the [API Reference](/docs/spec/v4/) for endpoints and schemas.

## Tips {#tips}

- Keep page paths short and stable (changing links later is disruptive).
- Create pages by audience (for example: public services vs internal systems).
- Add only relevant monitors per page to keep status pages readable.
- Use [Sharing Monitors](/docs/v4/sharing) to control badge/embed visibility per monitor.
- Public pages update themselves as monitors change status. See [Live Updates](/docs/v4/live-updates).
