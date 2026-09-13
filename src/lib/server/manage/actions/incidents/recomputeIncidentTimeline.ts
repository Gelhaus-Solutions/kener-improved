import db from "$lib/server/db/db.js";
import { GetIncidentByIDDashboard } from "$lib/server/controllers/controller.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition, ActionContext } from "../../types.js";

interface Payload {
  id?: number | string;
}

/**
 * KENER-150: recompute an incident's lifecycle timestamps from the evidence.
 *
 * **Why there is a button at all.** The original backfill only ever ran inside a
 * migration, and migrations run before seeds, so on a fresh install it swept an
 * empty table and was marked done for ever. The operator who notices is looking
 * at one incident whose Response Timeline says "Not recorded", and asking them
 * to find a shell to fix a display problem is how it stays unfixed.
 *
 * **Safe to press repeatedly, and that is a property of the routine rather than
 * of this action.** `backfillLifecycleTimestamps` only ever fills a column that
 * is currently NULL, so it cannot overwrite a stamp produced by a live
 * transition or by a human, and a second press is a no-op that says so.
 *
 * Scoped to the caller's org by the repository's `table()` chokepoint, so this
 * cannot reach another tenant's incident even if given its id: the id simply
 * matches nothing.
 */
export default {
  action: "recomputeIncidentTimeline",
  audit: {
    targetType: "incident",
    snapshot: async (data) => (data.id ? await GetIncidentByIDDashboard({ incident_id: Number(data.id) }) : undefined),
  },
  handler: async (data: Payload, _ctx: ActionContext) => {
    const incidentId = Number(data.id);
    if (!Number.isInteger(incidentId) || incidentId <= 0) {
      throw new ActionError(400, "An incident id is required");
    }

    const counts = await db.backfillLifecycleTimestamps(incidentId);
    const filled = counts.detected_at + counts.identified_at + counts.mitigated_at + counts.resolved_at;

    return { ...counts, filled };
  },
} satisfies ActionDefinition<Payload>;
