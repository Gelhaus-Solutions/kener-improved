import type { ActionContext, AnyActionDefinition } from "../types.js";
import { resolvedPermission } from "./authorize.js";

/**
 * Audit log capture points.
 *
 * Not enforced yet: the table, the batched writer and the redaction live in the
 * audit-log item. What exists here is the shape and, more importantly, the
 * positions, because those are what the rest of the pipeline is ordered around.
 *
 * The design rule this encodes: **the registry entry declares how to capture,
 * never what to write.** Every write action is logged with actor, action,
 * target, outcome and request id from the definition alone, with zero
 * per-action code, because anything requiring a line per action eventually gets
 * a line missed and the log quietly stops being evidence.
 *
 * `before` runs after requireOrg for a reason that is easy to get wrong: a
 * snapshot is a database read, and a read issued without an org context is a
 * cross-tenant read.
 */

export interface AuditRecord {
  action: string;
  permission: string | null | undefined;
  requestId: string;
  actorId: number;
  actorLabel: string;
  ip: string | null;
  userAgent: string | null;
  before?: unknown;
}

/** Captures pre-handler state, or nothing when the action opts out. */
export async function auditBefore(
  action: string,
  def: AnyActionDefinition | undefined,
  data: Record<string, unknown>,
  ctx: ActionContext,
): Promise<AuditRecord | null> {
  if (def?.audit === false) return null;

  const permission = resolvedPermission(action, def);
  // Reads are skipped: they are the bulk of the traffic and the least of the
  // evidence. An action with no permission at all is still logged, since
  // "nobody decided what this needs" is worth knowing about.
  if (typeof permission === "string" && permission.endsWith(".read")) return null;

  const snapshot = def?.audit ? def.audit.snapshot : undefined;

  return {
    action,
    permission,
    requestId: ctx.requestId,
    actorId: ctx.user.id,
    // Denormalised on capture: users get deleted, and an audit row that can no
    // longer say who did it is not an audit row.
    actorLabel: ctx.user.email ?? String(ctx.user.id),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    before: snapshot ? await snapshot(data) : undefined,
  };
}

/** Records the outcome. A no-op until the audit table exists. */
export async function auditAfter(
  record: AuditRecord | null,
  _def: AnyActionDefinition | undefined,
  _data: Record<string, unknown>,
  _outcome: "ok" | "denied" | "error",
  _statusCode: number,
): Promise<void> {
  if (!record) return;
  // Later: take the after-snapshot, shallow-diff it against record.before so
  // only changed keys are stored, redact recursively, and hand the row to the
  // batched writer so this costs the request nothing.
  return;
}
