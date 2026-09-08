import { json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { getActionDefinition } from "./registry.js";
import { ActionError } from "./types.js";
import type { ActionContext } from "./types.js";
import { authenticate } from "./middleware/authenticate.js";
import { requireOrg } from "./middleware/requireOrg.js";
import { authorize, isKnownAction } from "./middleware/authorize.js";
import { requireMfaEnrolment } from "./middleware/requireMfa.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { auditBefore, auditDiff, auditWrite, auditOutcomeOnly } from "./middleware/audit.js";
import { emitActionEvent } from "./middleware/events.js";
import { runWithEventContext, DEFAULT_ORG_ID } from "$lib/server/events/eventContext.js";

/**
 * The admin action pipeline.
 *
 * Order is load-bearing, not stylistic:
 *
 *   requestId -> authenticate -> requireMfa -> requireOrg -> authorize -> rateLimit
 *             -> validate -> audit:before -> handler -> audit:diff
 *             -> events -> audit:write -> errors
 *
 * The reasoning for each position lives on the middleware itself, so that
 * anyone about to move a step reads why it is where it is first. In short:
 * requireOrg both asserts and establishes so the context cannot be had without
 * the check; org context precedes validation and the audit snapshot so no query
 * runs unscoped; rate limiting sits after auth so tenants get separate buckets,
 * and before validation so floods stay cheap.
 *
 * `events` runs on success only, reusing the diff `audit:diff` already computed
 * rather than taking the same snapshot twice. It emits the *administrative*
 * events only; incidents and maintenances emit from inside the transaction that
 * changes them, because those must not be lost.
 *
 * `audit:write` runs after `events` and not before it, which is the one ordering
 * here that is about H8c rather than about cost. The audit log has a single
 * writer per change: if the action put anything on the bus, the audit consumer
 * writes the row from the event and this middleware stands down. It can only
 * know that after the emitting has happened.
 *
 * Every action is a file under `actions/<domain>/`. The transitional
 * `legacy.ts` fallback is gone: the registry is the only dispatch path.
 */
export async function runAction(event: RequestEvent): Promise<Response> {
  let payload: { action?: unknown; data?: unknown };
  try {
    payload = await event.request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = typeof payload.action === "string" ? payload.action : "";
  const data = (payload.data ?? {}) as Record<string, unknown>;

  // Set by requestIdHandle, first in the hooks sequence. The fallback covers
  // direct calls to runAction that do not come through the hooks (tests).
  const requestId = event.locals.requestId ?? crypto.randomUUID();

  const def = getActionDefinition(action);

  // Declared out here so the catch can attribute a failure to the caller. A
  // denial or an error is at least as worth recording as a success.
  let ctx: ActionContext | null = null;

  try {
    const { user, permissions, session } = await authenticate(event.cookies);

    ctx = {
      user,
      permissions,
      session,
      requestId,
      cookies: event.cookies,
      ip: safeClientAddress(event),
      userAgent: event.request.headers.get("user-agent"),
    };

    // Before requireOrg and before authorize: a user who owes the instance a
    // second factor is stopped whatever else is true of them, and telling them
    // about a missing permission first would send them off to fix the wrong
    // thing. See requireMfa.ts for why the admin API needs its own guard at all.
    await requireMfaEnrolment(action, ctx);

    // Returns the org and establishes it for the rest of this request, so every
    // repository call below - the audit snapshot included - is scoped without
    // anything else having to know about tenancy.
    const orgId = await requireOrg(ctx);

    // Deliberately after authenticate, not before it. The inherited chain
    // resolved the session first and only then consulted the permission map, so
    // an unknown action from a signed-out caller answered 401, not 400. Keeping
    // that order preserves the status codes and avoids telling an
    // unauthenticated caller which actions exist.
    if (!isKnownAction(action, def)) {
      return json({ error: "Unknown action" }, { status: 400 });
    }

    authorize(action, def, permissions);

    await rateLimit(action, def, ctx);

    // isKnownAction guarantees a definition exists past this point: the
    // permission map and the registry now cover exactly the same action set,
    // which the boot-time check in registry.ts and the sync-time diff both
    // depend on.
    if (!def) {
      return json({ error: "Unknown action" }, { status: 400 });
    }

    const validated = def.schema ? def.schema(data) : data;

    const auditRecord = await auditBefore(action, def, validated, ctx);

    // Establishes who is acting for the whole handler, so a controller three
    // layers down can emit an event attributed to this user without anyone
    // threading an actor argument through the call chain. See eventContext.ts.
    // Captured as a const: `ctx` is a `let` so the catch below can attribute a
    // failure, and TypeScript will not carry its narrowing into a closure.
    const actionCtx = ctx;
    // Collects the ids of every event emitted anywhere under this handler, at
    // any depth. `auditWrite` reads it to decide whether the audit row is owed
    // by this middleware or by the audit consumer. See middleware/audit.ts.
    const emitted: string[] = [];
    const eventCtx = {
      actor_type: "user" as const,
      actor_id: actionCtx.user.id,
      actor_label: actionCtx.user.email ?? String(actionCtx.user.id),
      correlation_id: requestId,
      org_id: orgId,
      emitted,
    };
    const result = await runWithEventContext(eventCtx, async () => await def.handler(validated, actionCtx));

    // Order below is load-bearing. The diff is computed first because the event
    // middleware needs it; the administrative event is emitted second, because
    // whether anything was emitted is what decides the third step; the audit row
    // is written last, and only if the bus is not already carrying this change.
    //
    // `emitActionEvent` runs inside the same context as the handler so its own
    // emit lands in `emitted` too. Without that the twenty actions in the
    // administrative map would be audited twice: once here and once by the
    // consumer that receives what this just emitted.
    if (result instanceof Response) {
      const ok = result.ok;
      const outcome = ok ? "ok" : "error";
      const diff = await auditDiff(auditRecord, validated, outcome);
      if (ok) {
        await runWithEventContext(eventCtx, async () => {
          await emitActionEvent(action, validated, actionCtx, diff);
        });
      }
      auditWrite(auditRecord, validated, diff, outcome, result.status, emitted);
      return result;
    }

    const diff = await auditDiff(auditRecord, validated, "ok");
    await runWithEventContext(eventCtx, async () => {
      await emitActionEvent(action, validated, actionCtx, diff);
    });
    auditWrite(auditRecord, validated, diff, "ok", 200, emitted);
    return json(result, { status: 200 });
  } catch (error: unknown) {
    const status = error instanceof ActionError ? error.status : 500;

    // 401s are not attributable to anyone and would let an unauthenticated
    // caller fill the log, so they are the one failure not recorded here.
    if (ctx) {
      // A 403 never reaches audit:before, by design: a denied action must not
      // run the snapshot queries it was denied the right to run. It still gets
      // a row, just without before/after.
      auditOutcomeOnly(action, def, data, ctx, status === 403 ? "denied" : "error", status);
    }

    if (error instanceof ActionError) {
      return json({ error: error.message }, { status: error.status });
    }
    // Everything else is a 500 carrying the message, which is what the
    // inherited chain did for every failure. Kept identical so migrating an
    // action cannot change how its errors look to the admin UI.
    console.log(error);
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, { status: 500 });
  }
}

/**
 * `event.getClientAddress()` throws when the adapter cannot determine an
 * address. An audit field is never worth failing a request over.
 */
function safeClientAddress(event: RequestEvent): string | null {
  try {
    return event.getClientAddress();
  } catch {
    return null;
  }
}
