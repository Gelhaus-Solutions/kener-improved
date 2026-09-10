import db from "$lib/server/db/db.js";
import { rollupsUsable } from "$lib/server/services/uptimeAggregator.js";
import { MERGED_REGION_ID } from "$lib/server/db/regions.js";
import { REPORT_GRAINS } from "$lib/server/reports/reportData.js";
import type { ActionDefinition } from "../../types.js";
import type { RollupGrain } from "$lib/server/types/db.js";

/**
 * Everything the Reports screen needs to draw its form (F2).
 *
 * The three things a scope can point at, plus - and this is the part that is not
 * cosmetic - **which grains can actually answer right now, and how far the data
 * reaches**. The export refuses with a 503 when the rollups for a grain are not
 * trustworthy, and a form that cheerfully offers a grain whose only possible
 * outcome is a failed download is a worse experience than one that greys it out
 * and says why.
 *
 * `latest_ts` is the watermark, which is where a report's range gets clamped to.
 * Handing it to the screen lets the date picker default to a range that will
 * come back whole rather than one that silently shrinks.
 */
export default {
  action: "getReportOptions",
  permission: "reports.read",
  handler: async () => {
    const monitors = await db.getMonitors({});
    const pages = await db.getAllPages();

    // Distinct, non-empty, sorted. Categories are a free-text column on
    // `monitors` rather than a table, so this is the only place the list exists.
    const categories = [
      ...new Set(monitors.map((monitor) => (monitor.category_name ?? "").trim()).filter((name) => name.length > 0)),
    ].sort((a, b) => a.localeCompare(b));

    const grains: Array<{ value: RollupGrain; usable: boolean; latest_ts: number | null }> = [];
    for (const grain of REPORT_GRAINS) {
      const usable = await rollupsUsable(grain);
      const state = usable ? await db.getRollupState(grain, MERGED_REGION_ID) : undefined;
      grains.push({ value: grain, usable, latest_ts: state?.watermark_ts ?? null });
    }

    return {
      monitors: monitors.map((monitor) => ({
        tag: monitor.tag,
        name: monitor.name,
        category_name: monitor.category_name ?? null,
      })),
      pages: pages.map((page) => ({ id: page.id, page_title: page.page_title, page_path: page.page_path })),
      categories,
      grains,
    };
  },
} satisfies ActionDefinition;
