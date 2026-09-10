import db from "../db/db.js";

/**
 * Resolving a scope to the monitors it names (F1a, F2).
 *
 * F1a introduced MONITOR / PAGE / CATEGORY for SLO targets. F2 needs the same
 * three for reports, plus ALL. Rather than write the resolution twice - the
 * repeated silent-drop bug in this repository is two code paths that were
 * supposed to agree and quietly stopped - it lives here once and
 * `slaEvaluator.resolveScope` delegates to it.
 *
 * **Hidden and inactive monitors are deliberately included**, exactly as F1a
 * decided for SLOs and for the same reason. Taking a component off the public
 * page does not take it out of the contract, and it does not take it out of the
 * operator's own export either. This is the opposite of `publicMonitorResolver`,
 * which decides what a stranger may *see*; this decides what a number is
 * computed *from*. Every caller here is authenticated and permission-checked.
 */

/** SLO targets use the first three. Reports use all four. */
export type MonitorScopeType = "MONITOR" | "PAGE" | "CATEGORY" | "ALL";

export const REPORT_SCOPE_TYPES: readonly MonitorScopeType[] = ["MONITOR", "PAGE", "CATEGORY", "ALL"];

/**
 * The monitor tags a scope resolves to.
 *
 * Returns an empty array when the scope names nothing that exists - a deleted
 * page, a category nobody uses, a monitor tag that is not in this org. Callers
 * treat empty as "no data", never as "everything": an export that silently
 * widened to the whole instance because a page id was stale would be the worst
 * possible failure for a document handed to a customer.
 */
export async function resolveScopeTags(scopeType: MonitorScopeType, scopeRef: string): Promise<string[]> {
  if (scopeType === "ALL") {
    const monitors = await db.getMonitors({});
    return monitors.map((monitor) => String(monitor.tag));
  }

  if (scopeType === "MONITOR") {
    const monitor = await db.getMonitorByTag(scopeRef);
    return monitor ? [scopeRef] : [];
  }

  if (scopeType === "PAGE") {
    const pageId = Number(scopeRef);
    if (!Number.isFinite(pageId)) return [];
    const rows = await db.getPageMonitors(pageId);
    return rows.map((row) => String(row.monitor_tag));
  }

  if (scopeType === "CATEGORY") {
    const monitors = await db.getMonitors({ category_name: scopeRef });
    return monitors.map((monitor) => String(monitor.tag));
  }

  return [];
}

/**
 * A human label for the scope, for the PDF cover and the email subject.
 *
 * Falls back to the raw reference when the named thing has gone, rather than
 * throwing: a report over a deleted page's former members should still say which
 * page it was, and a missing title is not a reason to fail a scheduled send.
 */
export async function describeScope(scopeType: MonitorScopeType, scopeRef: string): Promise<string> {
  if (scopeType === "ALL") return "All components";

  if (scopeType === "MONITOR") {
    const monitor = await db.getMonitorByTag(scopeRef);
    return monitor ? String(monitor.name) : scopeRef;
  }

  if (scopeType === "PAGE") {
    const pageId = Number(scopeRef);
    if (!Number.isFinite(pageId)) return scopeRef;
    const page = await db.getPageById(pageId);
    return page ? String(page.page_title) : `Page ${scopeRef}`;
  }

  if (scopeType === "CATEGORY") return scopeRef;

  return scopeRef;
}
