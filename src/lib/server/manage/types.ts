import type { Cookies } from "@sveltejs/kit";
import type { SessionRecord, UserRecordPublic } from "$lib/server/types/db";

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
  /**
   * The session row the caller presented, resolved once by `authenticate`.
   *
   * Carries `mfa_level` (which A2b's enrolment guard reads) and the id, which is
   * how an action spares the caller's own session when revoking the others.
   */
  session: SessionRecord;
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
  /**
   * The organisation this request acts in (I3f).
   *
   * Written by `requireOrg`, which is the middleware that validates it, so a
   * handler reading this is reading a membership-checked answer rather than
   * whatever the session claimed. It is the same number the ambient org context
   * carries; it lives here as well so that a handler acting *on* an org - rather
   * than merely querying inside one - says which org it means explicitly.
   */
  orgId: number;
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
   * Additional action strings this same definition answers to.
   *
   * Exists because the inherited chain had a branch matching two strings
   * (`getMonitorAlertConfig` and `getMonitorAlertConfigById`). Splitting that
   * into two files would duplicate the handler; dropping one would silently
   * break a caller. Use this only for genuine aliases of one behaviour, never
   * to group two actions that merely look similar.
   */
  aliases?: string[];

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
   * Restricts this action to the **instance** superadmin (KENER-31).
   *
   * A separate axis from `permission`, not a value of it, because the two ask
   * different questions: `permission` asks what role the caller holds in the org
   * they are acting in, and this asks whether they run the installation at all.
   * An action with this flag sets `permission: null` - there is no per-org
   * permission that could be the right answer, and inventing one would seed it
   * into every org's role editor for a tenant to grant themselves.
   *
   * Enforced by `requireSuperadmin`, immediately after `authorize`. Declarative
   * rather than a check inside each handler so that the gate is visible in the
   * definition, greppable across the tree, and cannot be reached by a handler
   * that forgot to open with it.
   *
   * See `instanceController.ts` for what makes somebody a superadmin.
   */
  superadmin?: boolean;

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
 * Payload type for actions transcribed from the inherited chain.
 *
 * It is `any`, deliberately and temporarily. The chain read `data` as `any` and
 * passed it straight into controllers whose inputs have required fields, so
 * anything narrower (even `Record<string, unknown>`) would force edits at the
 * call sites and turn a transcription into a redesign, which is exactly the risk
 * this migration is trying not to take.
 *
 * The name is the point: it marks every handler that has not been given a real
 * payload type yet. Replacing one with an interface plus a `schema` is a
 * self-contained improvement, and is worth doing first for anything that takes
 * an id, a secret, or a permission-relevant field.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LegacyPayload = any;

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
