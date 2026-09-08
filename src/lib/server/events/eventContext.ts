import { AsyncLocalStorage } from "node:async_hooks";
import type { EventActorType } from "./types.js";
import { DEFAULT_ORG_ID as ORG_DEFAULT, currentOrgIdOrDefault, runWithOrg } from "../db/orgContext.js";

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

  /**
   * Event ids emitted while this context was ambient, appended by `emit()`.
   *
   * This exists so the admin pipeline can answer one question after the handler
   * returns: did this action put anything on the bus? If it did, the audit
   * consumer writes the audit row and the pipeline must not write a second one.
   *
   * Collected ambiently rather than declared per action, and that is the point.
   * A declaration would be a list to keep in step with which handlers reach an
   * emitting controller, and the failure mode of that list falling behind is a
   * duplicated audit row or a missing one - neither of which anybody notices
   * until they are reading the log for a reason. Observing what actually
   * happened cannot drift.
   *
   * Only present where somebody is asking. `emit()` appends when the array
   * exists and does nothing when it does not, so a scheduler or a queue worker
   * pays nothing for this.
   */
  emitted?: string[];
}

const storage = new AsyncLocalStorage<EventContext>();

/**
 * The organisation everything belongs to until P4 says otherwise.
 *
 * Re-exported from `db/orgContext.ts`, which owns it as of I3c. The name stays
 * here because a dozen call sites import it from this module.
 */
export const DEFAULT_ORG_ID = ORG_DEFAULT;

/**
 * Runs `fn` with `context` as the ambient actor. Nests; the innermost wins.
 *
 * When the context carries an org it also enters the **org** context, so the two
 * cannot drift: `db/orgContext.ts` holds the single AsyncLocalStorage for the
 * org, and this is one of the two places that establishes it. Anything that
 * establishes an actor without an org - a queue worker for a system job, say -
 * leaves the org context alone, and a repository query against a tenant table
 * underneath it throws rather than quietly reading org 1.
 */
export function runWithEventContext<T>(context: EventContext, fn: () => Promise<T>): Promise<T> {
  if (context.org_id === undefined) return storage.run(context, fn);
  return runWithOrg(context.org_id, () => storage.run(context, fn));
}

export function getEventContext(): EventContext | undefined {
  return storage.getStore();
}

/**
 * Records that an event was emitted under the current context, if anybody is
 * collecting. Called by `emit()`; nothing else should call it.
 */
export function noteEmittedEvent(eventId: string): void {
  storage.getStore()?.emitted?.push(eventId);
}

/**
 * The org for the current context.
 *
 * Callers pass this to `emit()` explicitly rather than letting `emit()` default
 * it, which keeps `org_id` a mandatory parameter and keeps the compile error
 * that H8 wanted. What this removes is only the temptation to write `1`.
 *
 * **Reads the org context, not this module's store** (I3c). The two used to be
 * separate facts that happened to agree; now there is one, and it lives in
 * `db/orgContext.ts` beside the repository chokepoint that enforces it.
 *
 * Still falls back to the default org rather than throwing, and that is now the
 * right behaviour rather than a compromise: the strict version is
 * `requireOrgId`, which the repository layer calls on every tenant query. This
 * one is for stamping an `org_id` onto an event, where a system job with no org
 * genuinely means the default org.
 */
export function currentOrgId(): number {
  return currentOrgIdOrDefault();
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
