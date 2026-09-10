import db from "$lib/server/db/db.js";
import GC from "$lib/global-constants.js";
import { SLO_CALENDAR_PERIODS, SLO_COMBINATIONS, SLO_SCOPE_TYPES, SLO_WINDOW_TYPES } from "$lib/server/services/slo.js";
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
  show_on_public?: boolean;
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
      show_on_public: data.show_on_public === true ? GC.YES : GC.NO,
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
