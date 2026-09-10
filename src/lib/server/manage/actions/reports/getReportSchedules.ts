import db from "$lib/server/db/db.js";
import { computeNextRunAt } from "$lib/server/reports/reportSchedule.js";
import type { ActionDefinition } from "../../types.js";

/**
 * The schedules and their most recent artifacts (F4).
 *
 * `next_run_at` is returned as stored rather than recomputed, because the stored
 * value is what the scheduler will actually act on - showing a freshly computed
 * one would hide exactly the case worth seeing, a schedule whose rrule stopped
 * parsing and whose next run is therefore null.
 */
export default {
  action: "getReportSchedules",
  permission: "reports.read",
  handler: async () => {
    const schedules = await db.getReportSchedules();
    const artifacts = await db.getReportArtifacts(undefined, 100);

    const latestBySchedule = new Map<number, (typeof artifacts)[number]>();
    for (const artifact of artifacts) {
      if (artifact.report_schedule_id === null) continue;
      const existing = latestBySchedule.get(artifact.report_schedule_id);
      if (!existing || artifact.created_at > existing.created_at) {
        latestBySchedule.set(artifact.report_schedule_id, artifact);
      }
    }

    return {
      schedules: schedules.map((schedule) => ({
        ...schedule,
        recipients: safeArray(schedule.recipients),
        recipient_page_ids: safeArray(schedule.recipient_page_ids),
        // What the rrule *would* produce from now, shown beside the stored value
        // so an operator can see that a rule they just fixed will now fire.
        projected_next_run_at: computeNextRunAt(schedule.rrule, schedule.timezone, Math.floor(Date.now() / 1000)),
        latest_artifact: latestBySchedule.get(schedule.id) ?? null,
      })),
    };
  },
} satisfies ActionDefinition;

function safeArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
