import { json } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import { getActionDefinition } from "./registry.js";
import { ActionError } from "./types.js";
import type { ActionContext } from "./types.js";
import { authenticate } from "./middleware/authenticate.js";
import { requireOrg } from "./middleware/requireOrg.js";
import { authorize, isKnownAction } from "./middleware/authorize.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { auditBefore, auditAfter, auditOutcomeOnly } from "./middleware/audit.js";

/**
 * The admin action pipeline.
 *
 * Order is load-bearing, not stylistic:
 *
 *   requestId -> authenticate -> requireOrg -> authorize -> rateLimit
 *             -> validate -> audit:before -> handler -> audit:after -> errors
 *
 * The reasoning for each position lives on the middleware itself, so that
 * anyone about to move a step reads why it is where it is first. In short:
 * requireOrg both asserts and establishes so the context cannot be had without
 * the check; org context precedes validation and the audit snapshot so no query
 * runs unscoped; rate limiting sits after auth so tenants get separate buckets,
 * and before validation so floods stay cheap.
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
    const { user, permissions } = await authenticate(event.cookies);

    ctx = {
      user,
      permissions,
      requestId,
      cookies: event.cookies,
      ip: safeClientAddress(event),
      userAgent: event.request.headers.get("user-agent"),
    };

    await requireOrg(ctx);

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

    const result = await def.handler(validated, ctx);

    if (result instanceof Response) {
      await auditAfter(auditRecord, def, validated, result.ok ? "ok" : "error", result.status);
      return result;
    }

    await auditAfter(auditRecord, def, validated, "ok", 200);
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
