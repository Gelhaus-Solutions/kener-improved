import type { ActionContext, AnyActionDefinition } from "../types.js";
import { resolvedPermission } from "./authorize.js";
import { record } from "$lib/server/audit/writer.js";
import { diffSnapshots, redact, toJsonColumn } from "$lib/server/audit/redact.js";
import { GetNowTimestampUTC } from "$lib/server/tool.js";
import type { AuditOutcome } from "$lib/server/types/db.js";

/**
 * Audit capture, driven entirely by the registry entry.
 *
 * The rule this enforces: **a definition declares how to capture, never what to
 * write.** Every write action is logged with actor, action, outcome and request
 * id from the definition alone, with zero per-action code, because anything
 * needing a line per action is something that eventually gets a line missed, and
 * an audit log with gaps is not evidence.
 *
 * What an action may opt into:
 *   `audit: false`                  - not logged at all
 *   `audit: { targetType }`         - labels what kind of thing was acted on
 *   `audit: { snapshot }`           - called before and after; only changed keys
 *                                     are stored, redacted
 *
 * Reads are skipped by default. They are most of the traffic and least of the
 * evidence, and keeping them would bury the writes.
 *
 * Position is load-bearing: `before` runs after requireOrg, because a snapshot
 * is a database read and a read issued without an org context is a cross-tenant
 * read.
 */

export interface AuditRecord {
  action: string;
  permission: string | null | undefined;
  requestId: string;
  actorId: number;
  actorLabel: string;
  ip: string | null;
  userAgent: string | null;
  targetType: string | null;
  before: unknown;
  snapshot?: (data: Record<string, unknown>) => Promise<unknown>;
}

/** True when this action should produce an audit row at all. */
function shouldAudit(permission: string | null | undefined, def: AnyActionDefinition | undefined): boolean {
  if (def?.audit === false) return false;
  // An action with no permission mapping is still logged: "nobody decided what
  // this needs" is exactly the kind of thing an audit log should surface.
  if (typeof permission === "string" && permission.endsWith(".read")) return false;
  return true;
}

/** Captures pre-handler state, or null when the action is not audited. */
export async function auditBefore(
  action: string,
  def: AnyActionDefinition | undefined,
  data: Record<string, unknown>,
  ctx: ActionContext,
): Promise<AuditRecord | null> {
  const permission = resolvedPermission(action, def);
  if (!shouldAudit(permission, def)) return null;

  const audit = def?.audit ? def.audit : undefined;
  const snapshot = audit?.snapshot;

  let before: unknown;
  if (snapshot) {
    try {
      before = await snapshot(data);
    } catch (error) {
      // A snapshot is a nicety. Failing to take one must not fail the action it
      // was describing.
      console.error(`audit: before-snapshot failed for ${action}:`, error);
    }
  }

  return {
    action,
    permission,
    requestId: ctx.requestId,
    actorId: ctx.user.id,
    // Denormalised now, while the user still exists.
    actorLabel: ctx.user.email ?? String(ctx.user.id),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    targetType: audit?.targetType ?? null,
    before,
    snapshot,
  };
}

/**
 * Writes the row, and returns the before/after it computed.
 *
 * The return value exists so the event middleware can reuse the diff instead of
 * running the after-snapshot a second time: those snapshots are database reads,
 * and doing them twice per write action to produce the same answer is a cost
 * nobody would accept if it were visible.
 *
 * Never throws: auditing must not be able to fail a request.
 */
export async function auditAfter(
  auditRecord: AuditRecord | null,
  def: AnyActionDefinition | undefined,
  data: Record<string, unknown>,
  outcome: AuditOutcome,
  statusCode: number,
): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> } | null> {
  if (!auditRecord) return null;

  let computedDiff: { before: Record<string, unknown>; after: Record<string, unknown> } | null = null;

  try {
    let beforeJson: string | null = null;
    let afterJson: string | null = null;

    if (auditRecord.snapshot && outcome === "ok") {
      let after: unknown;
      try {
        after = await auditRecord.snapshot(data);
      } catch (error) {
        console.error(`audit: after-snapshot failed for ${auditRecord.action}:`, error);
      }
      const diff = diffSnapshots(auditRecord.before, after);
      if (diff) {
        computedDiff = diff as { before: Record<string, unknown>; after: Record<string, unknown> };
        beforeJson = toJsonColumn(diff.before);
        afterJson = toJsonColumn(diff.after);
      }
    }

    record({
      // P4 fills this from the org context established by requireOrg.
      org_id: null,
      ts: GetNowTimestampUTC(),
      request_id: auditRecord.requestId,
      actor_type: "user",
      actor_id: String(auditRecord.actorId),
      actor_label: auditRecord.actorLabel,
      action: auditRecord.action,
      permission: auditRecord.permission ?? null,
      target_type: auditRecord.targetType,
      target_id: extractTargetId(data),
      outcome,
      status_code: statusCode,
      ip: auditRecord.ip,
      user_agent: auditRecord.userAgent,
      before_json: beforeJson,
      after_json: afterJson,
      // The payload identifies what was acted on even without a snapshot, so a
      // redacted copy is kept for the actions that have not opted into one.
      meta_json: auditRecord.snapshot ? null : toJsonColumn(redact(data)),
    });
  } catch (error) {
    console.error("audit: failed to record", auditRecord.action, error);
  }

  return computedDiff;
}

/**
 * Best-effort target id from the payload.
 *
 * The chain used a dozen different names for "the thing being acted on", and
 * requiring each action to declare one would be exactly the per-action code this
 * design avoids. Guessing is fine here: it is a convenience column for
 * filtering, and the full payload is in `meta_json` regardless.
 */
function extractTargetId(data: Record<string, unknown>): string | null {
  for (const key of ["id", "tag", "monitor_tag", "page_id", "incident_id", "maintenance_id", "email", "key"]) {
    const v = data[key];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return null;
}

/**
 * Records a failed attempt: a denial or an error.
 *
 * Separate from the before/after pair because a failure has no "after", and a
 * denial must not take a snapshot: running the read that the caller was just
 * refused would be a small but real information leak through timing and load.
 *
 * Fire-and-forget on purpose. The request is already being answered and the
 * writer is buffered, so there is nothing to await.
 */
export function auditOutcomeOnly(
  action: string,
  def: AnyActionDefinition | undefined,
  data: Record<string, unknown>,
  ctx: ActionContext,
  outcome: AuditOutcome,
  statusCode: number,
): void {
  const permission = resolvedPermission(action, def);
  // Denials are recorded even for reads: being refused a read is a security
  // event in a way that performing one is not.
  if (def?.audit === false) return;
  if (outcome !== "denied" && typeof permission === "string" && permission.endsWith(".read")) return;

  try {
    record({
      org_id: null,
      ts: GetNowTimestampUTC(),
      request_id: ctx.requestId,
      actor_type: "user",
      actor_id: String(ctx.user.id),
      actor_label: ctx.user.email ?? String(ctx.user.id),
      action,
      permission: permission ?? null,
      target_type: def?.audit ? (def.audit.targetType ?? null) : null,
      target_id: extractTargetId(data),
      outcome,
      status_code: statusCode,
      ip: ctx.ip,
      user_agent: ctx.userAgent,
      before_json: null,
      after_json: null,
      meta_json: toJsonColumn(redact(data)),
    });
  } catch (error) {
    console.error("audit: failed to record failure for", action, error);
  }
}
