import type { Cookies } from "@sveltejs/kit";
import type { UserRecordPublic } from "$lib/server/types/db";

/**
 * Everything a handler is allowed to know about the caller.
 *
 * Resolved once by the pipeline and passed to every handler, so no handler
 * re-reads cookies or re-queries permissions. Adding a field here is the way to
 * give handlers new request-scoped information; reaching around it is not.
 */
export interface ActionContext {
  /** The authenticated admin user. Never null: authenticate() 401s first. */
  user: UserRecordPublic;
  /** The user's permission ids, fetched once per request. */
  permissions: Set<string>;
  /** Correlates this call with logs and, from P1's audit log, with audit rows. */
  requestId: string;
  /**
   * Raw cookies. Present because a handful of inherited handlers still read
   * them directly; prefer `user` and `permissions`. Will not survive P4's org
   * scoping unchanged.
   */
  cookies: Cookies;
  /** Client IP as SvelteKit resolved it, for audit rows. */
  ip: string | null;
  /** Inbound user agent, for audit rows. */
  userAgent: string | null;
}

/** The shape every action handler has. Returning a Response bypasses serialisation. */
export type ActionHandler<T = Record<string, unknown>> = (data: T, ctx: ActionContext) => Promise<unknown> | unknown;

/**
 * Validates and narrows an action's payload, throwing (ideally an ActionError
 * with status 400) when it does not fit.
 *
 * Deliberately a plain function rather than a schema-library type: this repo has
 * no validation dependency, and inventing one here would be a separate decision.
 * A zod schema's `.parse` fits this signature unchanged if one is adopted later.
 */
export type ActionValidator<T = Record<string, unknown>> = (data: Record<string, unknown>) => T;

export interface ActionDefinition<T = Record<string, unknown>> {
  /** The action string clients send. Must match the file's own name. */
  action: string;

  /**
   * Permission id required to run this.
   *
   * **Omit it.** The pipeline then looks the action up in ACTION_PERMISSION_MAP,
   * which keeps `allPerms.ts` the single source of truth and means an upstream
   * edit to that map keeps working with no change here. Set it explicitly only
   * for an action that has no entry there, which in practice means a
   * fork-invented action whose permission lives in `orgPerms.ts`.
   *
   * `null` means "authenticated is enough", matching the map's convention.
   */
  permission?: string | null;

  /**
   * Optional payload validation, run after authorization.
   *
   * Also the only way a handler gets a typed payload: whatever this returns is
   * what `handler` receives. Without it the handler sees the raw
   * `Record<string, unknown>`.
   */
  schema?: ActionValidator<T>;

  /** Seam for per-action rate limiting. Not enforced yet. */
  rateLimit?: { limit: number; windowSeconds: number };

  /**
   * Seam for the audit log.
   *
   * `false` opts out. `snapshot` is called before and after the handler so the
   * middleware can store a diff of what actually changed. Not enforced yet.
   */
  audit?: false | { targetType?: string; snapshot?: (data: T) => Promise<unknown> };

  handler: ActionHandler<T>;
}

/**
 * A definition with its payload type erased.
 *
 * The registry and the pipeline hold every action in one collection and treat
 * them uniformly, so they cannot know each one's payload type. Individual action
 * files keep their real types through `satisfies ActionDefinition<T>`; this
 * erasure exists only at the boundary that has to be heterogeneous.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActionDefinition = ActionDefinition<any>;

/**
 * An error carrying the HTTP status the client should see.
 *
 * Anything else thrown becomes a 500, which matches how the inherited chain
 * behaved for every failure. Throw this when the status is part of the meaning:
 * a 400 for a bad payload, a 403 for a check the handler makes itself.
 */
export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ActionError";
  }
}
