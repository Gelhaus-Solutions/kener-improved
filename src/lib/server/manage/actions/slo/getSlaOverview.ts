import db from "$lib/server/db/db.js";
import type { ActionDefinition } from "../../types.js";

/**
 * Everything the SLO admin screen needs, in one call.
 *
 * The targets and their evaluations, plus the three things a scope can point at.
 * One call rather than four because the form cannot be drawn until all of them
 * are known, and four round trips would only let the page render in a state
 * where every scope dropdown is empty.
 */
export default {
  action: "getSlaOverview",
  handler: async () => {
    const targets = await db.getSlaTargets();
    const evaluations = await db.getSlaEvaluations(targets.map((t) => t.id));
    const byTarget = new Map(evaluations.map((e) => [e.sla_target_id, e]));

    const monitors = await db.getMonitors({});
    const pages = await db.getAllPages();

    // Distinct, non-empty, sorted. Categories are a free-text column on
    // `monitors` rather than a table, so this is the only place the list exists.
    const categories = [
      ...new Set(monitors.map((monitor) => (monitor.category_name ?? "").trim()).filter((name) => name.length > 0)),
    ].sort((a, b) => a.localeCompare(b));

    return {
      targets: targets.map((target) => ({ ...target, evaluation: byTarget.get(target.id) ?? null })),
      monitors: monitors.map((monitor) => ({
        tag: monitor.tag,
        name: monitor.name,
        category_name: monitor.category_name ?? null,
      })),
      pages: pages.map((page) => ({ id: page.id, page_title: page.page_title, page_path: page.page_path })),
      categories,
    };
  },
} satisfies ActionDefinition;
