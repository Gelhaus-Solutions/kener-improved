import type { ActionContext, AnyActionDefinition } from "../types.js";

/**
 * Per-action rate limiting.
 *
 * Not enforced yet; the seam exists so the ordering is fixed before anything
 * depends on it. Both neighbours in the pipeline are deliberate:
 *
 * - **After authenticate.** A limit keyed on the authenticated caller means one
 *   tenant's flood cannot throttle another. Limiting before knowing who is
 *   calling can only key on IP, which shares a bucket between unrelated tenants
 *   behind the same NAT or proxy.
 * - **Before validate.** Rejecting a flood must be cheaper than parsing it,
 *   otherwise a malformed-body flood costs full validation per request and the
 *   limiter becomes the amplifier.
 */
export async function rateLimit(_action: string, _def: AnyActionDefinition | undefined, _ctx: ActionContext) {
  // Later: read def.rateLimit, count against a Redis window keyed by
  // (org, user, action), throw ActionError(429) past the limit. Must fail open
  // if Redis is unavailable, like the other Redis paths in this codebase.
  return;
}
