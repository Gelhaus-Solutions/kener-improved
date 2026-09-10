import db from "../db/db.js";
import type { PageRecord, PageRecordInsert, PageMonitorRecord, PageMonitorRecordInsert } from "../types/db.js";
import type { PageNavItem } from "./dashboardController.js";
import type { PageOrderingSettings } from "../../types/site.js";
import { GetSiteDataByKey } from "./siteDataController.js";

// ============ Page CRUD Operations ============

/**
 * Create a new page
 */
export async function CreatePage(data: PageRecordInsert): Promise<PageRecord> {
  // Validate required fields
  if (data.page_path === undefined || data.page_path === null || !data.page_title || !data.page_header) {
    throw new Error("page_path, page_title, and page_header are required");
  }

  // Make page_path URL-friendly: lowercase, replace spaces with hyphens, remove special chars (including leading slashes)
  data.page_path = data.page_path
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");

  // Check if page with this path already exists
  const existingPage = await db.getPageByPath(data.page_path);
  if (existingPage) {
    throw new Error(`Page with path "${data.page_path}" already exists`);
  }

  return await db.createPage(data);
}

/**
 * Get page by path
 */
export async function GetPageByPath(page_path: string): Promise<PageRecord | undefined> {
  return await db.getPageByPath(page_path);
}

/**
 * Get page by ID
 */
export async function GetPageById(id: number): Promise<PageRecord | undefined> {
  return await db.getPageById(id);
}

/**
 * Get all pages
 */
export async function GetAllPages(): Promise<PageRecord[]> {
  return await db.getAllPages();
}

/**
 * The pages the public switcher may list, ordered (G3).
 *
 * **One definition, used by both callers.** The layout renders the switcher from
 * this, and `/dashboard-apis/pages` answers from it too. They were separate
 * before, and separate would mean the endpoint listing a page the switcher hides
 * the moment either grew a rule the other did not - which is exactly what the
 * per-page `listed` flag below would have caused.
 *
 * **Org scoping is not done here, and that is the point.** `db.getAllPages()`
 * goes through `BaseRepository.table()`, `pages` is in `TENANT_TABLES`, and the
 * request's org was established by `orgResolveHandle` from the hostname. So this
 * is scoped by the same chokepoint as everything else rather than by a filter
 * somebody has to remember to write - and with no org context at all it throws
 * rather than quietly listing every tenant's pages.
 */
export async function GetSwitcherPages(): Promise<PageNavItem[]> {
  const [allPages, orderingSettings] = await Promise.all([
    db.getAllPages(),
    GetSiteDataByKey("pageOrderingSettings") as Promise<PageOrderingSettings | null>,
  ]);

  // A page opts *out*, so every page that predates the flag keeps appearing.
  const listed = allPages.filter((page) => {
    if (!page.page_settings_json) return true;
    try {
      const parsed =
        typeof page.page_settings_json === "string" ? JSON.parse(page.page_settings_json) : page.page_settings_json;
      return parsed?.switcher?.listed !== false;
    } catch {
      // Unparseable settings must not remove a page from navigation: the page
      // itself still renders, and a switcher that silently drops it is worse
      // than one that shows it.
      return true;
    }
  });

  let ordered = listed;
  if (orderingSettings?.enabled && orderingSettings.order?.length > 0) {
    const orderMap = new Map(orderingSettings.order.map((id, idx) => [id, idx]));
    ordered = [...listed].sort((a, b) => {
      const aIdx = orderMap.get(a.id);
      const bIdx = orderMap.get(b.id);
      // Pages in the order list come first, sorted by their position
      if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
      if (aIdx !== undefined) return -1;
      if (bIdx !== undefined) return 1;
      // Pages not in the order list keep their default order (by id)
      return a.id - b.id;
    });
  }

  return ordered.map((p) => ({
    page_title: p.page_title,
    page_path: p.page_path,
    page_header: p.page_header,
    page_logo: p.page_logo,
  }));
}

/**
 * Update page by ID
 */
export async function UpdatePage(id: number, data: Partial<PageRecordInsert>): Promise<PageRecord> {
  // Check if page exists
  const existingPage = await db.getPageById(id);
  if (!existingPage) {
    throw new Error(`Page with id ${id} not found`);
  }

  // If updating page_path, make it URL-friendly
  if (data.page_path !== undefined) {
    data.page_path = data.page_path
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "");
  }

  // If updating page_path, check if it conflicts with another page
  if (data.page_path !== undefined && data.page_path !== existingPage.page_path) {
    const conflictingPage = await db.getPageByPath(data.page_path);
    if (conflictingPage) {
      throw new Error(`Page with path "${data.page_path}" already exists`);
    }
  }

  await db.updatePage(id, data);
  return (await db.getPageById(id))!;
}

/**
 * Delete page by ID
 */
export async function DeletePage(id: number): Promise<void> {
  // Check if page exists
  const existingPage = await db.getPageById(id);
  if (!existingPage) {
    throw new Error(`Page with id ${id} not found`);
  }

  // Prevent deleting the home page (empty path)
  if (existingPage.page_path === "") {
    throw new Error("Cannot delete the home page");
  }

  await db.deletePage(id);
}

// ============ Page Monitor Operations ============

/**
 * Add monitor to a page
 */
export async function AddMonitorToPage(
  page_id: number,
  monitor_tag: string,
  monitor_settings_json?: string | null,
  position?: number,
): Promise<void> {
  // Check if page exists
  const page = await db.getPageById(page_id);
  if (!page) {
    throw new Error(`Page with id ${page_id} not found`);
  }

  // Check if monitor already exists on page
  const exists = await db.monitorExistsOnPage(page_id, monitor_tag);
  if (exists) {
    throw new Error(`Monitor "${monitor_tag}" already exists on this page`);
  }

  // If no position specified, append at end
  let finalPosition = position;
  if (finalPosition === undefined) {
    const existing = await db.getPageMonitors(page_id);
    finalPosition = existing.length > 0 ? Math.max(...existing.map((m) => m.position)) + 1 : 0;
  }

  await db.addMonitorToPage({
    page_id,
    monitor_tag,
    monitor_settings_json: monitor_settings_json || null,
    position: finalPosition,
  });
}

/**
 * Reorder monitors on a page
 */
export async function ReorderPageMonitors(page_id: number, monitor_tags: string[]): Promise<void> {
  const page = await db.getPageById(page_id);
  if (!page) {
    throw new Error(`Page with id ${page_id} not found`);
  }

  const monitorPositions = monitor_tags.map((tag, index) => ({
    monitor_tag: tag,
    position: index,
  }));

  await db.updatePageMonitorPositions(page_id, monitorPositions);
}

/**
 * Remove monitor from a page
 */
export async function RemoveMonitorFromPage(page_id: number, monitor_tag: string): Promise<void> {
  // Check if page exists
  const page = await db.getPageById(page_id);
  if (!page) {
    throw new Error(`Page with id ${page_id} not found`);
  }

  const deleted = await db.removeMonitorFromPage(page_id, monitor_tag);
  if (deleted === 0) {
    throw new Error(`Monitor "${monitor_tag}" not found on this page`);
  }
}

/**
 * Get all monitors for a page
 */
export async function GetPageMonitors(page_id: number): Promise<PageMonitorRecord[]> {
  return await db.getPageMonitors(page_id);
}

/**
 * Update monitor settings on a page
 */
export async function UpdatePageMonitorSettings(
  page_id: number,
  monitor_tag: string,
  monitor_settings_json: string | null,
): Promise<void> {
  // Check if page exists
  const page = await db.getPageById(page_id);
  if (!page) {
    throw new Error(`Page with id ${page_id} not found`);
  }

  // Check if monitor exists on page
  const exists = await db.monitorExistsOnPage(page_id, monitor_tag);
  if (!exists) {
    throw new Error(`Monitor "${monitor_tag}" not found on this page`);
  }

  await db.updatePageMonitorSettings(page_id, monitor_tag, monitor_settings_json);
}

/**
 * Get page with its monitors
 */
export async function GetPageWithMonitors(
  page_id: number,
): Promise<{ page: PageRecord; monitors: PageMonitorRecord[] } | undefined> {
  const page = await db.getPageById(page_id);
  if (!page) {
    return undefined;
  }

  const monitors = await db.getPageMonitors(page_id);
  return { page, monitors };
}

/**
 * Get page by path with its monitors (excluding hidden monitors)
 */
export async function GetPageByPathWithMonitors(
  page_path: string,
): Promise<{ page: PageRecord; monitors: PageMonitorRecord[] } | undefined> {
  const page = await db.getPageByPath(page_path);
  if (!page) {
    return undefined;
  }

  const monitors = await db.getPageMonitorsExcludeHidden(page.id);
  return { page, monitors };
}
