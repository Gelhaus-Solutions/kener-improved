import type { Handle } from "@sveltejs/kit";
import { runWithEventContext, DEFAULT_ORG_ID } from "$lib/server/events/eventContext.js";
import type { EventActorType } from "$lib/server/events/types.js";

/**
 * Establishes the ambient event actor for every request.
 *
 * Without this, an incident updated through the v4 API emits an event
 * attributed to `system`, which is indistinguishable from one the scheduler
 * produced. That is the sort of gap nobody notices until an audit asks who
 * changed something.
 *
 * The attribution here is deliberately coarse:
 *
 *   api_key    an authenticated API request; *which* key is not resolved,
 *              because `apiAuthHandle` verifies the token by hash and never
 *              needs the row. A10 (scoped API keys) is what gives this an id.
 *   anonymous  everything else, including public page loads
 *
 * The admin action pipeline opens a *nested* context with the real signed-in
 * user, which wins for the duration of the handler. So this handle sets the
 * floor rather than the answer, and a request that reaches an admin action is
 * attributed to the person, not to `anonymous`.
 *
 * Runs after `apiAuthHandle`, so an unauthenticated API request has already been
 * rejected and cannot be attributed to a key it never presented.
 *
 * Lives here rather than inline in `hooks.server.ts` for the same reason
 * `requestId.ts` does: that file is upstream's, and holding the fork's addition
 * to one import plus one name in `sequence(...)` is what keeps it cheap to merge.
 */
export const eventContextHandle: Handle = async ({ event, resolve }) => {
  const requestId = (event.locals as { requestId?: string }).requestId ?? null;

  const hasBearer = (event.request.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
  const actor_type: EventActorType = hasBearer && event.url.pathname.includes("/api/") ? "api_key" : "anonymous";

  return await runWithEventContext(
    {
      actor_type,
      correlation_id: requestId,
      // P4's orgResolveHandle replaces this with the org the hostname or path
      // resolved to. Until then every request belongs to the only org there is.
      org_id: DEFAULT_ORG_ID,
    },
    async () => await resolve(event),
  );
};
