import { ValidateBackfill, estimateOverlayRows, type BackfillInput } from "$lib/server/incidents/backfill.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  incidents?: BackfillInput[];
}

/**
 * Checks a whole import without writing anything.
 *
 * The importer runs this first and shows every problem at once. Failing on row
 * three and leaving the operator to discover rows seven and nine one at a time
 * is how a fifty-row CSV takes an afternoon.
 *
 * A read: it changes nothing, so it maps to `incidents.read` and is not audited.
 */
export default {
  action: "validateIncidentBackfill",
  audit: false,
  handler: async (data: Payload) => {
    const rows = data.incidents ?? [];
    const results = [];
    let totalRows = 0;

    for (const [index, incident] of rows.entries()) {
      const problems = await ValidateBackfill(incident);
      const overlay =
        incident.write_timeline === false
          ? 0
          : estimateOverlayRows(incident.start_date_time, incident.end_date_time, incident.components ?? []);
      totalRows += overlay;
      results.push({ index, title: incident.title, problems, overlay_rows: overlay });
    }

    return {
      results,
      total_overlay_rows: totalRows,
      ok: results.every((r) => r.problems.length === 0),
    };
  },
} satisfies ActionDefinition<Payload>;
