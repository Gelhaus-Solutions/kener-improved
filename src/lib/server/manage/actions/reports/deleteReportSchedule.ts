import db from "$lib/server/db/db.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  id?: number;
}

/**
 * Deletes a schedule (F4).
 *
 * **Artifacts already generated are deliberately left alone.** They carry
 * `report_schedule_id` with no cascade, so links already sitting in recipients'
 * inboxes keep working until their own expiry. Deleting a schedule means "stop
 * sending this", not "revoke the reports already sent"; an operator who wants
 * the second can wait out the expiry, which is at most a week.
 */
export default {
  action: "deleteReportSchedule",
  permission: "reports.write",
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isInteger(id) || id <= 0) throw new ActionError(400, "A schedule id is required");

    const existing = await db.getReportScheduleById(id);
    if (!existing) throw new ActionError(404, "Schedule not found");

    await db.deleteReportSchedule(id);
    return { deleted: true };
  },
} satisfies ActionDefinition<Payload>;
