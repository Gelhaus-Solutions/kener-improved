import db from "$lib/server/db/db.js";
import GC from "$lib/global-constants.js";
import {
  SLO_CALENDAR_PERIODS,
  SLO_COMBINATIONS,
  SLO_PUBLIC_DETAILS,
  SLO_PUBLIC_SURFACES,
  SLO_SCOPE_TYPES,
  SLO_SURFACES_BY_SCOPE,
  SLO_WINDOW_TYPES,
  isSurfaceValidForScope,
  type SloScopeType,
} from "$lib/server/services/slo.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  /** Absent creates; present updates. */
  id?: number | null;
  name?: string;
  scope_type?: string;
  scope_ref?: string;
  combination?: string;
  region_id?: number;
  objective_percent?: number;
  window_type?: string;
  window_days?: number | null;
  calendar_period?: string | null;
  exclude_maintenance?: boolean;
  degraded_counts_as_bad?: boolean;
  /**
   * Where this target appears publicly. An empty array is "nowhere".
   *
   * Replaces the old `show_on_public` boolean, which could say "publish" without
   * saying where - and for a page- or category-scoped target there was nowhere,
   * so it published to nothing at all.
   */
  public_placements?: string[];
  /** COMPACT | FULL. */
  public_detail?: string;
  status?: string;
}

/**
 * Creates or updates an SLO target.
 *
 * **The scope is checked against the thing it names, not just against a list of
 * legal words.** A target pointing at a deleted page or a misspelled category
 * resolves to zero monitors, and a target measuring zero monitors reports no
 * data forever without ever looking broken. Rejecting it here is the only point
 * where somebody is present to be told.
 */
export default {
  action: "saveSlaTarget",
  audit: { targetType: "sla_target" },
  handler: async (data: Payload) => {
    const name = String(data.name ?? "").trim();
    if (!name) throw new ActionError(400, "A name is required");

    const scopeType = String(data.scope_type ?? "MONITOR");
    if (!SLO_SCOPE_TYPES.includes(scopeType as never)) {
      throw new ActionError(400, `scope_type must be one of ${SLO_SCOPE_TYPES.join(", ")}`);
    }

    const scopeRef = String(data.scope_ref ?? "").trim();
    if (!scopeRef) throw new ActionError(400, "A scope is required");

    if (scopeType === "MONITOR") {
      if (!(await db.getMonitorByTag(scopeRef))) throw new ActionError(400, `Monitor "${scopeRef}" does not exist`);
    } else if (scopeType === "PAGE") {
      const pageId = Number(scopeRef);
      if (!Number.isFinite(pageId) || !(await db.getPageById(pageId))) {
        throw new ActionError(400, `Page "${scopeRef}" does not exist`);
      }
    } else {
      const monitors = await db.getMonitors({ category_name: scopeRef });
      if (monitors.length === 0) throw new ActionError(400, `No monitors are in category "${scopeRef}"`);
    }

    const combination = String(data.combination ?? "WORST");
    if (!SLO_COMBINATIONS.includes(combination as never)) {
      throw new ActionError(400, `combination must be one of ${SLO_COMBINATIONS.join(", ")}`);
    }

    const objective = Number(data.objective_percent);
    // Zero is not a target and 100 leaves no budget to express a percentage of,
    // so both ends are excluded rather than clamped.
    if (!Number.isFinite(objective) || objective <= 0 || objective >= 100) {
      throw new ActionError(400, "objective_percent must be greater than 0 and less than 100");
    }

    const windowType = String(data.window_type ?? "ROLLING");
    if (!SLO_WINDOW_TYPES.includes(windowType as never)) {
      throw new ActionError(400, `window_type must be one of ${SLO_WINDOW_TYPES.join(", ")}`);
    }

    let windowDays: number | null = null;
    let calendarPeriod: string | null = null;
    if (windowType === "ROLLING") {
      windowDays = Number(data.window_days);
      if (!Number.isFinite(windowDays) || windowDays <= 0) {
        throw new ActionError(400, "window_days must be a positive number of days");
      }
      // Bounded by what the rollups can be asked for: a window longer than the
      // history retained is a target that silently measures less than it claims.
      if (windowDays > 365) throw new ActionError(400, "window_days cannot exceed 365");
    } else {
      calendarPeriod = String(data.calendar_period ?? "MONTH");
      if (!SLO_CALENDAR_PERIODS.includes(calendarPeriod as never)) {
        throw new ActionError(400, `calendar_period must be one of ${SLO_CALENDAR_PERIODS.join(", ")}`);
      }
    }

    // **Every placement is checked against the scope, not just against the list
    // of legal words.** The combinations left out are the ones that would
    // publish a misleading figure - a page-wide number on one component's page
    // reads as that component's attainment - and refusing here is the only point
    // where somebody is present to be told which one was wrong.
    const requested = Array.isArray(data.public_placements) ? data.public_placements.map(String) : [];
    const placements = Array.from(new Set(requested));
    for (const placement of placements) {
      if (!SLO_PUBLIC_SURFACES.includes(placement as never)) {
        throw new ActionError(400, `Unknown placement "${placement}"`);
      }
      if (!isSurfaceValidForScope(scopeType, placement)) {
        throw new ActionError(
          400,
          `A ${scopeType.toLowerCase()}-scoped target cannot be placed on "${placement}". Allowed: ${SLO_SURFACES_BY_SCOPE[scopeType as SloScopeType].join(", ")}`,
        );
      }
    }

    const detail = String(data.public_detail ?? "FULL");
    if (!SLO_PUBLIC_DETAILS.includes(detail as never)) {
      throw new ActionError(400, `public_detail must be one of ${SLO_PUBLIC_DETAILS.join(", ")}`);
    }

    const row = {
      name,
      scope_type: scopeType,
      scope_ref: scopeRef,
      combination,
      region_id: Number.isFinite(Number(data.region_id)) ? Number(data.region_id) : 0,
      objective_percent: objective,
      window_type: windowType,
      window_days: windowDays,
      calendar_period: calendarPeriod,
      exclude_maintenance: data.exclude_maintenance === false ? GC.NO : GC.YES,
      degraded_counts_as_bad: data.degraded_counts_as_bad === true ? GC.YES : GC.NO,
      public_placements: JSON.stringify(placements),
      public_detail: detail,
      // Derived, never chosen. Kept in step so anything outside this repo still
      // reading the old boolean gets the same answer; nothing here reads it.
      show_on_public: placements.length > 0 ? GC.YES : GC.NO,
      status: data.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    };

    const id = Number(data.id);
    if (Number.isFinite(id) && id > 0) {
      if (!(await db.getSlaTargetById(id))) throw new ActionError(404, "That SLO target does not exist");
      await db.updateSlaTarget(id, row);
      return { success: true, id };
    }

    const created = await db.createSlaTarget(row);
    return { success: true, id: created };
  },
} satisfies ActionDefinition<Payload>;
