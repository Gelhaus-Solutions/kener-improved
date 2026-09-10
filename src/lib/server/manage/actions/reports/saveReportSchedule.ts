import db from "$lib/server/db/db.js";
import { GetNowTimestampUTC } from "$lib/server/tool.js";
import { REPORT_SCOPE_TYPES, type MonitorScopeType } from "$lib/server/services/monitorScope.js";
import { REPORT_FORMATS, REPORT_GRAINS } from "$lib/server/reports/reportData.js";
import {
  REPORT_RANGE_KINDS,
  computeNextRunAt,
  isValidTimezone,
  type ReportRangeKind,
} from "$lib/server/reports/reportSchedule.js";
import { ActionError } from "../../types.js";
import type { ActionDefinition } from "../../types.js";
import type { RollupGrain } from "$lib/server/types/db.js";
import type { ReportFormat } from "$lib/server/reports/reportData.js";

interface Payload {
  id?: number;
  name?: string;
  scope_type?: string;
  scope_ref?: string;
  format?: string;
  grain?: string;
  range_kind?: string;
  rrule?: string;
  timezone?: string;
  recipients?: string[];
  recipient_page_ids?: number[];
  exclude_maintenance?: boolean;
  degraded_counts_as_bad?: boolean;
  status?: string;
}

/** Deliberately permissive: the real check is that the mail server accepts it. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Creates or updates a report schedule (F4).
 *
 * **The rrule is validated by computing its next run**, not by a regex. A rule
 * that parses but never produces an occurrence is as useless as one that does
 * not parse, and both come back as null from `computeNextRunAt`, so one check
 * covers both and the value it produces is the one that gets stored.
 *
 * **A schedule with no recipients is refused.** It would render a file every
 * month, store it, expire it and mail nobody - a feature that appears to work
 * and does nothing, which is the worst outcome available here.
 */
export default {
  action: "saveReportSchedule",
  permission: "reports.write",
  handler: async (data: Payload) => {
    const name = (data.name ?? "").trim();
    if (name.length === 0) throw new ActionError(400, "A name is required");
    if (name.length > 255) throw new ActionError(400, "That name is too long");

    const scopeType = (data.scope_type ?? "ALL") as MonitorScopeType;
    if (!REPORT_SCOPE_TYPES.includes(scopeType)) {
      throw new ActionError(400, `scope_type must be one of ${REPORT_SCOPE_TYPES.join(", ")}`);
    }
    const scopeRef = data.scope_ref ?? "";
    if (scopeType !== "ALL" && scopeRef === "") {
      throw new ActionError(400, "Choose what the report should cover");
    }

    const format = (data.format ?? "pdf") as ReportFormat;
    if (!REPORT_FORMATS.includes(format))
      throw new ActionError(400, `format must be one of ${REPORT_FORMATS.join(", ")}`);

    const grain = (data.grain ?? "1d") as RollupGrain;
    if (!REPORT_GRAINS.includes(grain)) throw new ActionError(400, `grain must be one of ${REPORT_GRAINS.join(", ")}`);

    const rangeKind = (data.range_kind ?? "PREV_MONTH") as ReportRangeKind;
    if (!REPORT_RANGE_KINDS.includes(rangeKind)) {
      throw new ActionError(400, `range_kind must be one of ${REPORT_RANGE_KINDS.join(", ")}`);
    }

    const timezone = data.timezone ?? "UTC";
    if (!isValidTimezone(timezone)) throw new ActionError(400, `"${timezone}" is not a recognised time zone`);

    const rrule = (data.rrule ?? "").trim();
    if (rrule.length === 0) throw new ActionError(400, "A recurrence rule is required");

    const now = GetNowTimestampUTC();
    const nextRunAt = computeNextRunAt(rrule, timezone, now);
    if (nextRunAt === null) {
      throw new ActionError(400, "That recurrence rule never produces a next run. Check the rule and the time zone.");
    }

    const recipients = (data.recipients ?? []).map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
    for (const recipient of recipients) {
      if (!EMAIL.test(recipient)) throw new ActionError(400, `"${recipient}" is not a valid email address`);
    }
    const pageIds = (data.recipient_page_ids ?? [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (recipients.length === 0 && pageIds.length === 0) {
      throw new ActionError(400, "Add at least one recipient, or the report would be generated and sent to nobody");
    }

    const row = {
      name,
      scope_type: scopeType,
      scope_ref: scopeRef,
      format,
      grain,
      range_kind: rangeKind,
      rrule,
      timezone,
      recipients: JSON.stringify(recipients),
      recipient_page_ids: JSON.stringify(pageIds),
      exclude_maintenance: data.exclude_maintenance === false ? "NO" : "YES",
      degraded_counts_as_bad: data.degraded_counts_as_bad === true ? "YES" : "NO",
      status: data.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      next_run_at: nextRunAt,
      updated_at: now,
    };

    if (data.id) {
      const existing = await db.getReportScheduleById(Number(data.id));
      if (!existing) throw new ActionError(404, "Schedule not found");
      // `last_error` is cleared on every save: the operator has just changed
      // something, and leaving a stale failure on screen would suggest the new
      // configuration had already failed.
      await db.updateReportSchedule(existing.id, { ...row, last_error: null });
      return { id: existing.id, next_run_at: nextRunAt };
    }

    const id = await db.insertReportSchedule({
      ...row,
      last_run_at: null,
      last_error: null,
      created_at: now,
    });
    return { id, next_run_at: nextRunAt };
  },
} satisfies ActionDefinition<Payload>;
