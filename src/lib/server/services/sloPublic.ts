import type { SlaEvaluationRow, SlaTargetRow } from "../db/repositories/sla.js";
import type { SloPublicSurface } from "./slo.js";

/**
 * What a published SLO looks like to a visitor, and the one place that decides it.
 *
 * **Every loader that publishes an SLO goes through here.** The public status
 * page exists twice in this codebase - `(kener)/+page.svelte` and
 * `(kener)/[page_path]/+page.svelte` - and the component page is a third
 * surface, so a projection written at the call site would be three copies that
 * drift. It also means the rule about what never leaves the server is stated
 * once.
 *
 * **Burn rates never leave.** They say how fast a budget is being spent, which
 * is a fact about the provider's alerting rather than about the service, and
 * they are the field most likely to be read as a prediction. Neither preset
 * includes them and there is no option that does.
 *
 * **Nothing else on the target leaves either.** Every value a loader returns is
 * serialised into the page's hydration payload whether or not the template
 * renders it, so filtering in a component would publish the whole row to anyone
 * who reads the HTML.
 */

export interface PublicSlo {
  name: string;
  /** Attainment over the window, as a percentage. */
  uptimePercent: number;
  objectivePercent: number;
  /** Whether attainment has fallen below the objective. */
  breached: boolean;
  /** FULL only. Null when the evaluation could not compute one. */
  budgetRemainingPercent: number | null;
  /** FULL only. A locale-neutral token, e.g. "30d (UTC)" or "2026-09 (UTC)". */
  window: string | null;
}

/**
 * The window a published figure covers, as a token that needs no translating.
 *
 * Derived from the evaluation's own `window_start` rather than from the clock,
 * so a figure computed just before midnight on 30 September still says `2026-09`
 * when it is read a minute later. "Rolling 30 days" would be the one part of a
 * panel translated into 24 languages that was stuck in English.
 */
export function publicWindowLabel(
  target: { window_type: string; window_days: number | null; calendar_period: string | null },
  windowStart: number,
): string {
  if (target.window_type !== "CALENDAR") return `${target.window_days ?? 30}d (UTC)`;
  const start = new Date(windowStart * 1000);
  const year = start.getUTCFullYear();
  if (target.calendar_period === "YEAR") return `${year} (UTC)`;
  if (target.calendar_period === "QUARTER") return `${year}-Q${Math.floor(start.getUTCMonth() / 3) + 1} (UTC)`;
  return `${year}-${String(start.getUTCMonth() + 1).padStart(2, "0")} (UTC)`;
}

/**
 * Projects one target and its evaluation into the public shape.
 *
 * Returns null when there is nothing honest to show. A target created minutes
 * ago has no evaluation yet, and one whose window contains no samples has a null
 * attainment; publishing either as a figure would render an empty row that reads
 * as an outage.
 */
export function publicSloView(target: SlaTargetRow, evaluation: SlaEvaluationRow | null): PublicSlo | null {
  if (!evaluation || evaluation.uptime_percent === null) return null;

  const full = target.public_detail !== "COMPACT";
  return {
    name: target.name,
    uptimePercent: evaluation.uptime_percent,
    objectivePercent: target.objective_percent,
    // Computed here rather than in the component so that every surface agrees on
    // what a breach is, including the ones that show no numbers at all.
    breached: evaluation.uptime_percent < target.objective_percent,
    budgetRemainingPercent: full ? evaluation.budget_remaining_percent : null,
    window: full ? publicWindowLabel(target, evaluation.window_start) : null,
  };
}

export interface PublishedTarget {
  target: SlaTargetRow;
  evaluation: SlaEvaluationRow | null;
}

/**
 * The published figures for one surface, optionally narrowed to one scope ref.
 *
 * The placement check is here rather than in SQL because the column holds a JSON
 * array: a `LIKE` over it would match `PAGE_TOP` inside a longer token and would
 * do it differently on each dialect.
 */
export function publishedSlosFor(
  rows: ReadonlyArray<PublishedTarget>,
  surface: SloPublicSurface,
  scopeRef?: string,
): PublicSlo[] {
  const out: PublicSlo[] = [];
  for (const row of rows) {
    if (!row.target.public_placements.includes(surface)) continue;
    if (scopeRef !== undefined && row.target.scope_ref !== scopeRef) continue;
    const view = publicSloView(row.target, row.evaluation);
    if (view) out.push(view);
  }
  return out;
}

export interface PublicSloSurfaces {
  /** Placed at the top of this page. */
  pageSlos: PublicSlo[];
  /** Placed on a category section header, keyed by category name. */
  categorySlos: Record<string, PublicSlo[]>;
  /** Placed beside a component in the list, keyed by physical monitor tag. */
  monitorSlos: Record<string, PublicSlo[]>;
}

/**
 * Everything one status page publishes, bucketed by where it goes.
 *
 * **Placement decides where a figure appears; a breach is surfaced regardless.**
 * An operator who put a component's SLO only on that component's own page has
 * still asked for it to be public, and a contract being missed is the one thing
 * a visitor should not have to go looking for. So a breached target is folded
 * into the surface belonging to whatever it is about - its component, its
 * category, or the page - even when it was placed somewhere else. That is the
 * only case where a figure appears on a surface it was not placed on, and it is
 * deliberate.
 *
 * Merged here rather than in the components because otherwise the same
 * deduplication would be written once per surface, in two page templates and a
 * list component, and the one that got it wrong would quietly render a breached
 * target twice.
 *
 * `allowed` is what the page actually shows. Without it a status page would
 * carry every other page's components in its hydration payload, which is
 * published whether or not anything renders it.
 */
export function publicSloSurfacesFor(
  rows: ReadonlyArray<PublishedTarget>,
  allowed: { pageRef: string; monitors: ReadonlySet<string>; categories: ReadonlySet<string> },
): PublicSloSurfaces {
  const out: PublicSloSurfaces = { pageSlos: [], categorySlos: {}, monitorSlos: {} };

  const bucketFor = (row: PublishedTarget): PublicSlo[] | null => {
    const { scope_type: scope, scope_ref: ref } = row.target;
    if (scope === "PAGE") return ref === allowed.pageRef ? out.pageSlos : null;
    if (scope === "CATEGORY") return allowed.categories.has(ref) ? (out.categorySlos[ref] ??= []) : null;
    if (scope === "MONITOR") return allowed.monitors.has(ref) ? (out.monitorSlos[ref] ??= []) : null;
    return null;
  };

  for (const row of rows) {
    const view = publicSloView(row.target, row.evaluation);
    if (!view) continue;

    const placedHere =
      row.target.public_placements.includes("PAGE_TOP") ||
      row.target.public_placements.includes("CATEGORY_SECTION") ||
      row.target.public_placements.includes("STATUS_PAGE_COMPONENT");

    // Placed on one of this page's surfaces, or breached and therefore surfaced
    // anyway. A target placed only on its component page and meeting its
    // objective appears on neither, which is what the operator asked for.
    if (!placedHere && !view.breached) continue;

    const bucket = bucketFor(row);
    if (!bucket) continue;
    // One entry per target. A target both placed here and breached is one
    // figure, already carrying `breached`.
    if (bucket.some((existing) => existing.name === view.name)) continue;
    bucket.push(view);
  }

  return out;
}
