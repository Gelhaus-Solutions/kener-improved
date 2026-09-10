import db from "$lib/server/db/db.js";
import { isComponentImpact } from "$lib/server/incidents/impact.js";
import GC from "$lib/global-constants.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  monitor_tag: string;
  rollup_mode?: string;
  manual_override?: string | null;
  manual_override_reason?: string | null;
  /** Hours from now until the pin lapses. Null or absent means it does not. */
  manual_override_hours?: number | null;
  /**
   * Whether the public page names this monitor's neighbours. Absent leaves it
   * as it was, so a caller that only means to change the rollup mode does not
   * have to know this field exists.
   */
  show_dependencies?: boolean;
}

const MODES = ["NONE", "WORST", "WEIGHTED"];

/**
 * Sets a component's rollup mode and its manual pin.
 *
 * The pin is a **different thing** from `incidents.impact_override`, which
 * answers "this incident's impact is really X". This one answers "this component
 * is X whatever rolls up", with no incident involved, and it outlives any single
 * incident - which is exactly why it takes an expiry. A pin set during an outage
 * and never removed is a component that has quietly stopped telling the truth,
 * and nothing on the screen would say so a month later.
 */
export default {
  action: "setMonitorRollup",
  permission: "monitors.write",
  audit: { targetType: "monitor_rollup" },
  handler: async (data: Payload) => {
    const tag = String(data.monitor_tag ?? "");
    if (!tag) throw new ActionError(400, "A monitor is required");
    if (!(await db.getMonitorByTag(tag))) throw new ActionError(400, `Monitor "${tag}" does not exist`);

    const mode = String(data.rollup_mode ?? "NONE");
    if (!MODES.includes(mode)) throw new ActionError(400, `rollup_mode must be one of ${MODES.join(", ")}`);

    const override = data.manual_override ?? null;
    if (override !== null && !isComponentImpact(override)) {
      throw new ActionError(400, `manual_override must be a component impact, or null to clear it`);
    }

    // Computed here rather than taken as a timestamp, so the caller cannot set a
    // pin that expired before it was created.
    const hours = Number(data.manual_override_hours);
    const expiresAt =
      override !== null && Number.isFinite(hours) && hours > 0
        ? Math.floor(Date.now() / 1000) + Math.round(hours * 3600)
        : null;

    await db.upsertRollupSetting({
      monitor_tag: tag,
      rollup_mode: mode,
      manual_override: override,
      // A reason only means anything while there is a pin to explain.
      manual_override_reason: override === null ? null : (data.manual_override_reason ?? null),
      manual_override_expires_at: expiresAt,
      show_dependencies: data.show_dependencies === undefined ? undefined : data.show_dependencies ? GC.YES : GC.NO,
    });
    return { success: true };
  },
} satisfies ActionDefinition<Payload>;
