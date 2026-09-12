import { json, type RequestHandler } from "@sveltejs/kit";
import { CreateHash } from "$lib/server/controllers/commonController";
import { receiveInboundAlert } from "$lib/server/inbound/receive";
import { checkInboundRateLimit } from "$lib/server/inbound/rateLimit";

/**
 * H1. The public endpoint somebody else's alerting posts to.
 *
 * **Outside `/api/`, and that is a routing constraint rather than a preference.**
 * `apiAuthHandle` requires a bearer token for everything under `/api/`, and its
 * public allowlist is exact-match with no parameters, so a token-in-path route
 * cannot live there. `(ext)` is where Kener already keeps unauthenticated
 * machine endpoints - `ext/heartbeat/[tag]/[secret]` is the same shape - so this
 * joins them.
 *
 * **One route, not one per provider.** The backlog described a route per
 * provider; the token identifies the endpoint, and the endpoint already records
 * which provider it is for. Taking the provider from the row rather than the URL
 * means the two can never disagree: an operator who pastes their Alertmanager
 * URL into Grafana gets their Grafana payload parsed as Grafana, rather than a
 * confusing failure from a route that was told otherwise.
 *
 * **Everything here happens before the token is known to be real**, so each step
 * is ordered by what it costs: the size cap first because it needs nothing, the
 * rate limit next because it needs only a hash, and the database last.
 */

/**
 * The largest payload accepted, before it is parsed.
 *
 * An Alertmanager group of a few hundred alerts is tens of kilobytes. A
 * megabyte is far past any legitimate sender and well short of what it would
 * take to hurt the process, and refusing at the cap costs nothing because the
 * body is never read.
 */
const MAX_BODY_BYTES = 1_000_000;

const handler: RequestHandler = async ({ params, request }) => {
  const token = params.token ?? "";
  if (!token) return json({ error: "A token is required" }, { status: 401 });

  // Declared length first: refusing here means never reading the body at all.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: "Payload too large" }, { status: 413 });
  }

  const tokenHash = CreateHash(token);

  // Before the database, so a sender retrying in a loop is capped without
  // costing a query per attempt.
  const limit = await checkInboundRateLimit(tokenHash);
  if (!limit.allowed) {
    return json(
      { error: "Too many requests" },
      { status: 429, headers: { "retry-after": String(limit.retryAfter) } },
    );
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "Could not read the request body" }, { status: 400 });
  }

  // A sender that lied about `content-length`, or sent none.
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: "Payload too large" }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let result;
  try {
    result = await receiveInboundAlert(token, payload);
  } catch (error) {
    // A 5xx tells the sender to retry, which is what we want when the fault is
    // ours: the alert is not lost, it arrives again in a minute.
    console.error("Inbound alert receive failed:", error);
    return json({ error: "Could not process that alert" }, { status: 500 });
  }

  if (!result.ok) {
    return json({ error: result.reason }, { status: result.status });
  }

  // The counts are the useful half of the response. A sender that believes it
  // reported an outage and reads back `opened: 0, unmapped: 1` has been told
  // exactly what is wrong with its mapping, without anybody opening a database.
  return json({
    accepted: result.accepted,
    opened: result.opened,
    resolved: result.resolved,
    unmapped: result.unmapped,
  });
};

export const POST = handler;
