import { AsyncLocalStorage } from "node:async_hooks";

// The organisation every query belongs to, for the duration of a request or a job.
//
// **This is the single source of truth for the ambient org.** `eventContext.ts`
// also exposes `currentOrgId()`, and it delegates here rather than keeping its
// own store: two AsyncLocalStorages holding the same fact would eventually
// disagree, and the failure mode of that disagreement is a row written into the
// wrong tenant, which nothing would catch.
//
// It mirrors poolContext.ts and trxContext.ts, in the same directory and for the
// same reason: threading an `orgId` argument through ~350 repository signatures
// would change every call site, conflict with upstream forever, and still leave
// forgetting it silent. Ambient plus a chokepoint in `BaseRepository.table()`
// turns a missed scope into a thrown error instead of a cross-tenant read.
//
// The rule this module exists to enforce: **a query against a tenant table with
// no org context is a bug, not a query against every org.**

/** Thrown when a tenant-scoped query runs with no organisation established. */
export class MissingOrgContextError extends Error {
  constructor(table: string) {
    super(
      `No organisation context for a query against "${table}". ` +
        "Every request, job and scheduler tick must run inside runWithOrg(); " +
        "genuinely instance-wide work must say so with runAcrossOrgs().",
    );
    this.name = "MissingOrgContextError";
  }
}

interface OrgContext {
  /** The org, or null when running deliberately across every org. */
  orgId: number | null;
  /** True only inside `runAcrossOrgs`, so a null org reads as intentional. */
  system: boolean;
  /**
   * The `/o/<slug>` prefix this request arrived under, or `""` (I3e).
   *
   * Carried here rather than passed around because `serverResolve` is called
   * from everywhere and has no request of its own. Empty for host-routed
   * traffic, for the default org, and for every background job - which is
   * correct: a link built by the scheduler belongs to no browsing session.
   */
  pathPrefix?: string;
}

const storage = new AsyncLocalStorage<OrgContext>();

/**
 * The org that owns everything predating tenancy.
 *
 * Mirrored in `eventContext.ts` and in the migrations, which cannot import it.
 */
export const DEFAULT_ORG_ID = 1;

/**
 * Runs `fn` with `orgId` as the ambient organisation. Nests; the innermost wins.
 *
 * `pathPrefix` is the `/o/<slug>` the request came in under, and is inherited by
 * a nested call that does not name one - so `requireOrg` switching to the
 * session's org does not throw away the prefix the visitor is browsing under.
 */
export function runWithOrg<T>(orgId: number, fn: () => Promise<T>, pathPrefix?: string): Promise<T> {
  const inherited = pathPrefix ?? storage.getStore()?.pathPrefix ?? "";
  return storage.run({ orgId, system: false, pathPrefix: inherited }, fn);
}

/**
 * Runs `fn` with no organisation, deliberately.
 *
 * The bypass for the handful of genuinely instance-wide reads: resolving an api
 * key *before* its org is known, the org tables themselves, and the scheduler
 * loops that fan out across every org. Each is a decision, so it is written at
 * the call site where it can be read and grepped, rather than being what happens
 * when somebody forgets.
 *
 * **Named `runAcrossOrgs`, not `runAsSystem`, though the item specified the
 * latter.** `eventContext.ts` already exports a `runAsSystem` and it means
 * something else entirely - "attribute these events to the system rather than to
 * a person" - while saying nothing about tenancy. Two functions with one name
 * and different meanings, both imported into the same files, is a mistake
 * waiting to be made silently: the wrong import compiles and leaves the org
 * context exactly as it was.
 */
export function runAcrossOrgs<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ orgId: null, system: true }, fn);
}

/**
 * Sets the ambient organisation for the remainder of the current async context.
 *
 * `runWithOrg` takes a callback and is the right tool almost everywhere. This one
 * exists for the admin action pipeline, where the org is only known after the
 * session has been resolved and membership checked, and where wrapping the
 * remaining sixty lines of the pipeline in a closure would bury the ordering
 * that pipeline is written to make obvious.
 *
 * `enterWith` bleeds into everything that follows in the same async context,
 * which is exactly the intent here: that context is one admin request. Do not
 * reach for it anywhere the surrounding scope outlives the org - a queue worker
 * processing jobs for several tenants, say - because there the bleed is the bug.
 */
export function enterOrg(orgId: number): void {
  storage.enterWith({ orgId, system: false, pathPrefix: storage.getStore()?.pathPrefix ?? "" });
}

/** The current context, or undefined when none is established. */
export function getOrgContext(): OrgContext | undefined {
  return storage.getStore();
}

/** The current org, or null inside `runAsSystem`. Undefined context throws. */
export function requireOrgId(table: string): number | null {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingOrgContextError(table);
  return ctx.orgId;
}

/**
 * The current org, falling back to the default.
 *
 * For the few callers that need a number rather than a decision - the `org_id`
 * stamped onto an outbox event, say. Prefer `requireOrgId` anywhere a wrong
 * answer would be a leak.
 */
export function currentOrgIdOrDefault(): number {
  return storage.getStore()?.orgId ?? DEFAULT_ORG_ID;
}

/** The `/o/<slug>` prefix the current request arrived under, or `""`. */
export function currentOrgPathPrefix(): string {
  return storage.getStore()?.pathPrefix ?? "";
}
