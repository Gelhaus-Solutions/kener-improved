import { BackfillIncident, ValidateBackfill, type BackfillInput } from "$lib/server/incidents/backfill.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  incidents?: BackfillInput[];
}

/**
 * Imports historical incidents.
 *
 * **Validated in full before anything is written.** A partial import is the
 * worst outcome here: half the outages recorded, no way to tell which half, and
 * a second run that duplicates the ones that succeeded. So every row is checked
 * first and the whole request is refused if any row fails.
 *
 * Not a database transaction, though, and that is a deliberate limit rather than
 * an oversight: each incident enqueues an overlay job, and a job enqueued inside
 * a transaction can be picked up before the transaction commits. Validating
 * everything up front is what makes a mid-import failure improbable rather than
 * impossible; the response names exactly what was created either way.
 */
export default {
  action: "backfillIncidents",
  audit: { targetType: "incident" },
  handler: async (data: Payload) => {
    const rows = data.incidents ?? [];
    if (rows.length === 0) throw new ActionError(400, "Nothing to import");

    for (const [index, incident] of rows.entries()) {
      const problems = await ValidateBackfill(incident);
      if (problems.length > 0) {
        throw new ActionError(400, `Row ${index + 1} ("${incident.title ?? "untitled"}"): ${problems.join("; ")}`);
      }
    }

    const created: Array<{ incident_id: number; title: string; overlay_rows: number }> = [];
    for (const incident of rows) {
      const result = await BackfillIncident(incident);
      created.push({ incident_id: result.incident_id, title: incident.title, overlay_rows: result.overlay_rows });
    }

    return { created, count: created.length };
  },
} satisfies ActionDefinition<Payload>;
