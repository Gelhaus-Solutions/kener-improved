import { redisConnection } from "../redisConnector.js";

/**
 * H1. A fixed-window request cap, per inbound endpoint.
 *
 * **Why these endpoints and not the admin API.** `manage/middleware/rateLimit.ts`
 * is still a documented stub because every admin action is already behind a
 * session. These URLs are not behind anything: the token is the only gate, and
 * until it has been checked Kener has already parsed a stranger's JSON. A
 * misconfigured Alertmanager retrying a rejected delivery in a tight loop is the
 * ordinary case, not an attack, and it is enough to keep a database busy.
 *
 * **Fixed window, not a sliding one.** A sliding window needs a sorted set per
 * endpoint and a trim on every request; a fixed window is one INCR and one
 * EXPIRE. The cost of the cheap version is that a sender can get up to twice the
 * limit across a window boundary, which for a cap meant to stop a runaway loop
 * rather than to meter a paid API is not worth a sorted set.
 *
 * **It fails open.** Redis being down must not stop a customer's outage reaching
 * their status page. That is the same judgement the admin stub's TODO records,
 * and it is the right one here for a stronger reason: refusing alerts because
 * the cache is unavailable turns a Redis incident into a silent monitoring
 * outage, which is precisely when the alerts matter most.
 */

/**
 * Requests per window per endpoint.
 *
 * 120 a minute is far above any real alerting source: Alertmanager groups and
 * re-sends on an interval measured in minutes, and even a fleet of senders
 * sharing one endpoint does not approach this. It is set where a runaway retry
 * loop is stopped and a correctly configured sender never notices.
 */
export const INBOUND_RATE_LIMIT = 120;
export const INBOUND_RATE_WINDOW_SECONDS = 60;

export interface RateLimitVerdict {
  allowed: boolean;
  /** What the sender should wait, in seconds, when refused. */
  retryAfter: number;
}

/**
 * Counts this request against the endpoint's window.
 *
 * The key carries the window number rather than being a rolling TTL, so two
 * processes counting the same endpoint agree on which window they are in without
 * coordinating. `EXPIRE` is set only when the counter is created, so a long
 * burst cannot keep pushing the window's end further out.
 */
export async function checkInboundRateLimit(
  /**
   * The hashed token, not the endpoint id.
   *
   * Deliberately something the route knows *before* it has touched the database,
   * so a sender in a retry loop is capped without costing a query per attempt.
   * Keyed on the hash rather than the token itself so Redis never holds a
   * credential.
   */
  key: string,
  now: number = Math.floor(Date.now() / 1000),
  limit: number = INBOUND_RATE_LIMIT,
  windowSeconds: number = INBOUND_RATE_WINDOW_SECONDS,
): Promise<RateLimitVerdict> {
  const window = Math.floor(now / windowSeconds);
  const bucket = `inbound:rl:${key}:${window}`;
  const resetsAt = (window + 1) * windowSeconds;
  const retryAfter = Math.max(1, resetsAt - now);

  try {
    const redis = redisConnection();
    const count = await redis.incr(bucket);
    if (count === 1) {
      // Only on creation. Re-expiring on every request would extend the window
      // for as long as the burst lasts, which is the opposite of a cap.
      await redis.expire(bucket, windowSeconds + 1);
    }
    return { allowed: count <= limit, retryAfter };
  } catch (error) {
    // Fail open. See the note above: a cache outage must not become a
    // monitoring outage.
    console.error("Inbound rate limit check failed, allowing the request:", error);
    return { allowed: true, retryAfter };
  }
}
