import type { Handle } from "@sveltejs/kit";

/**
 * Assigns every request an id, exposes it as `locals.requestId`, and echoes it
 * back as `X-Request-Id`.
 *
 * Runs **first** in the hooks sequence. Anything that logs or audits wants the
 * id, so nothing useful can come before it.
 *
 * An inbound `X-Request-Id` is honoured, so a trace started at a proxy or by a
 * calling service survives into Kener's own records. It is validated first: the
 * value ends up in a database column and in log lines, so an unbounded or
 * newline-bearing header would be a log-injection vector. Anything that does not
 * look like an id is replaced rather than rejected, because a malformed trace
 * header is not worth failing a request over.
 *
 * This lives in `$lib/server/http` rather than inline in `hooks.server.ts` on
 * purpose: `hooks.server.ts` is upstream's file, and keeping the fork's addition
 * to one import plus one name in the `sequence(...)` call is what keeps it cheap
 * to merge on every sync.
 */
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

export const requestIdHandle: Handle = async ({ event, resolve }) => {
  const inbound = event.request.headers.get("x-request-id");
  const requestId = inbound && VALID_REQUEST_ID.test(inbound) ? inbound : crypto.randomUUID();

  (event.locals as { requestId?: string }).requestId = requestId;

  const response = await resolve(event);
  response.headers.set("X-Request-Id", requestId);
  return response;
};
