import db from "$lib/server/db/db";
import type { ActionDefinition } from "../../types.js";
import type { AuditActorType, AuditLogFilter, AuditOutcome } from "$lib/server/types/db";

interface GetAuditLogPayload {
  page: number;
  limit: number;
  filter: AuditLogFilter;
}

const MAX_LIMIT = 200;

/**
 * The first fork-invented action, so unlike everything else in the registry its
 * permission is not in upstream's map. It resolves through
 * ORG_ACTION_PERMISSION_MAP instead, which is exactly the seam orgPerms.ts
 * exists for; nothing is declared here.
 *
 * `audit: false` because reading the audit log should not append to it. Left
 * explicit rather than relying on the `.read` skip, since this is the one action
 * where a self-referential loop would be actively confusing.
 */
export default {
  action: "getAuditLog",
  audit: false,
  schema: (data): GetAuditLogPayload => {
    const raw = (data.filter ?? {}) as Record<string, unknown>;
    const filter: AuditLogFilter = {};
    if (typeof raw.action === "string" && raw.action) filter.action = raw.action;
    if (typeof raw.actor_id === "string" && raw.actor_id) filter.actor_id = raw.actor_id;
    if (typeof raw.actor_type === "string" && raw.actor_type) filter.actor_type = raw.actor_type as AuditActorType;
    if (typeof raw.outcome === "string" && raw.outcome) filter.outcome = raw.outcome as AuditOutcome;
    if (Number.isFinite(Number(raw.start))) filter.start = Number(raw.start);
    if (Number.isFinite(Number(raw.end))) filter.end = Number(raw.end);

    return {
      page: Math.max(1, Number(data.page) || 1),
      // Capped: this endpoint is a paginated reader, not an export. A bulk
      // export of the audit log is its own decision with its own permission.
      limit: Math.min(MAX_LIMIT, Math.max(1, Number(data.limit) || 50)),
      filter,
    };
  },
  handler: async ({ page, limit, filter }) => {
    const [rows, total] = await Promise.all([
      db.getAuditLogPaginated(filter, page, limit),
      db.getAuditLogCount(filter),
    ]);
    return { rows, total: total ? Number(total.count) : 0 };
  },
} satisfies ActionDefinition<GetAuditLogPayload>;
