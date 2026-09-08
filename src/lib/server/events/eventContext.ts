import { AsyncLocalStorage } from "node:async_hooks";
import type { EventActorType } from "./types.js";

// Who is acting, and on whose behalf, for the duration of a request or a job.
//
// The problem: `emit()` wants an actor and a correlation id, but the code that
// knows a state change happened is a controller several layers below whoever
// resolved the session. `incidentController.AddIncidentComment` is called from
// an admin action, from the v4 API and from `alertingQueue`, and threading an
// actor argument through all three would change every signature in between and
// still be forgotten somewhere.
//
// So the actor is ambient, exactly like the transaction in trxContext.ts and the
// connection pool in poolContext.ts. The pipeline establishes it per request,
// the queue workers establish "system", and `emit()` reads it. A controller
// stays unaware that actors exist.
//
// The alternative considered and rejected was passing the actor explicitly to
// every emit call. It is more honest in the small and worse in the large: the
// failure mode is not a compile error but an event attributed to "system" that a
// human actually caused, which is invisible until an audit needs it.

export interface EventActor {
  actor_type: EventActorType;
  actor_id?: string | number | null;
  actor_label?: string | null;
}

export interface EventContext extends EventActor {
  /**
   * Ties every event from one request together, and to the audit rows from the
   * same request. The pipeline passes the `X-Request-Id` through, so a trace
   * that started at a proxy reaches the outbox.
   */
  correlation_id?: string | null;
  org_id?: number;
}

const storage = new AsyncLocalStorage<EventContext>();

/**
 * The organisation everything belongs to until P4 says otherwise.
 *
 * Single-org installs are every install today, and the schema defaults to 1 to
 * match. This constant exists so P4 (I3a-I3d) has one symbol to change rather
 * than a scattering of literal `1`s to find.
 */
export const DEFAULT_ORG_ID = 1;

/** Runs `fn` with `context` as the ambient actor. Nests; the innermost wins. */
export function runWithEventContext<T>(context: EventContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function getEventContext(): EventContext | undefined {
  return storage.getStore();
}

/**
 * The org for the current context.
 *
 * Callers pass this to `emit()` explicitly rather than letting `emit()` default
 * it, which keeps `org_id` a mandatory parameter and keeps the compile error
 * that H8 wanted. What this removes is only the temptation to write `1`.
 *
 * **P4 must make this throw when no context is established.** Today it cannot,
 * because nothing establishes one outside the request pipeline and a scheduler
 * has no request. Once I3d wires the context into jobs and schedulers, the
 * fallback below becomes the bug it currently prevents.
 */
export function currentOrgId(): number {
  return storage.getStore()?.org_id ?? DEFAULT_ORG_ID;
}

/**
 * The actor for the current context, or the system actor.
 *
 * Falling back to `system` is correct rather than lossy: an event emitted with
 * no ambient actor genuinely was caused by the scheduler or a queue worker, not
 * by a person.
 */
export function currentActor(): EventActor {
  const ctx = storage.getStore();
  if (!ctx) return { actor_type: "system" };
  return { actor_type: ctx.actor_type, actor_id: ctx.actor_id, actor_label: ctx.actor_label };
}

export function currentCorrelationId(): string | null {
  return storage.getStore()?.correlation_id ?? null;
}

/** Convenience for background work: runs `fn` attributed to the system. */
export function runAsSystem<T>(fn: () => Promise<T>, correlationId?: string): Promise<T> {
  return runWithEventContext({ actor_type: "system", correlation_id: correlationId ?? null }, fn);
}
