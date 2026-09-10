import db from "$lib/server/db/db.js";
import { GetNowTimestampUTC } from "$lib/server/tool.js";
import reportQueue from "$lib/server/queues/reportQueue.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";

interface Payload {
  id?: number;
}

/**
 * Sends a schedule immediately, without disturbing its schedule (F4).
 *
 * **This exists because the alternative is testing in production by waiting a
 * month.** A monthly report is configured once and then not seen again until the
 * 1st, and discovering on the 1st that the scope was wrong is the expensive way
 * to find out.
 *
 * `manual: true` is what keeps it from advancing `next_run_at`: a test send at
 * 14:00 on the 12th must not move the real delivery, and the job id carries the
 * same flag so a manual run and a scheduled one due at the same instant are
 * different jobs rather than one deduplicated away.
 *
 * It really does mail the recipients. That is the point - a dry run that skipped
 * delivery would not test the half most likely to be misconfigured - and the
 * admin UI says so before it is pressed.
 */
export default {
  action: "runReportScheduleNow",
  permission: "reports.write",
  handler: async (data: Payload) => {
    const id = Number(data.id);
    if (!Number.isInteger(id) || id <= 0) throw new ActionError(400, "A schedule id is required");

    const schedule = await db.getReportScheduleById(id);
    if (!schedule) throw new ActionError(404, "Schedule not found");

    await reportQueue.push({
      orgId: schedule.org_id,
      scheduleId: schedule.id,
      firedAt: GetNowTimestampUTC(),
      manual: true,
    });

    return { queued: true };
  },
} satisfies ActionDefinition<Payload>;
