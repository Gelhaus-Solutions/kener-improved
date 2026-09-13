/**
 * E11 part 4. When a webhook delivery is allowed to go out.
 *
 * Pure arithmetic, deliberately: the two rules below are the whole feature, and
 * keeping them free of database and clock access is what makes them testable
 * without a fixture. Everything that reads a row lives in the consumer.
 *
 * **Neither rule ever drops an event.** Both postpone. An outbound integration's
 * delivery log is an evidence trail, and an event that vanished because a
 * counter was high would look exactly like a bug in the relay.
 */

/** The largest window worth offering. Beyond this, batching is a digest. */
export const MAX_BATCH_WINDOW_SECONDS = 3600;

/** A ceiling below this would throttle even an idle endpoint's single event. */
export const MIN_MAX_PER_MINUTE = 1;

/**
 * The instant a delivery created at `now` becomes due, given a batch window.
 *
 * **Aligned to a fixed grid rather than measured from the event**, and that is
 * the entire reason batching collapses anything. Per-event windows would give
 * each event its own deadline, so five events arriving a second apart would
 * become five requests a second apart, which is the behaviour being fixed. A
 * shared boundary makes every event in the same window due at the same moment,
 * so one request picks up all of them.
 *
 * The boundary is exclusive of `now` when `now` already sits on it: an event
 * landing exactly on a grid line belongs to the window that is opening, not to
 * the one that just closed and may already have been swept.
 */
export function batchWindowEnd(now: number, windowSeconds: number): number {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return now;
  const window = Math.min(Math.floor(windowSeconds), MAX_BATCH_WINDOW_SECONDS);
  return (Math.floor(now / window) + 1) * window;
}

/**
 * The instant a delivery becomes due given a per-minute ceiling.
 *
 * `recentCount` is how many deliveries this endpoint has already been sent in
 * the trailing minute. Under the ceiling it is due now; at or over it, it waits
 * for the oldest of those to fall out of the window.
 *
 * `oldestRecentAt` is when that oldest delivery went out. Without one - the
 * counter says the endpoint is saturated but nothing says when it will not be -
 * a whole minute is the only safe answer.
 */
export function ceilingDelayUntil(
  now: number,
  maxPerMinute: number,
  recentCount: number,
  oldestRecentAt: number | null,
): number {
  if (!Number.isFinite(maxPerMinute) || maxPerMinute < MIN_MAX_PER_MINUTE) return now;
  if (recentCount < maxPerMinute) return now;

  // One second past the moment the oldest attempt leaves the trailing minute,
  // so the retry lands after the window has actually moved rather than exactly
  // on the boundary where it would be refused again.
  const freesAt = oldestRecentAt === null ? now + 60 : oldestRecentAt + 61;
  return Math.max(now, freesAt);
}

/** Endpoint settings as the scheduler reads them. */
export interface NoisePolicy {
  batchWindowSeconds: number | null;
  maxPerMinute: number | null;
}

/**
 * When a delivery created at `now` should first be attempted.
 *
 * The later of the two rules wins, because they are both floors: a ceiling that
 * says "not before 14:03" and a window that says "not before 14:05" together
 * mean 14:05. Taking the earlier would let one knob silently defeat the other.
 */
export function nextAttemptAt(
  now: number,
  policy: NoisePolicy,
  recentCount: number,
  oldestRecentAt: number | null,
): number {
  let due = now;

  if (policy.batchWindowSeconds && policy.batchWindowSeconds > 0) {
    due = Math.max(due, batchWindowEnd(now, policy.batchWindowSeconds));
  }

  if (policy.maxPerMinute && policy.maxPerMinute >= MIN_MAX_PER_MINUTE) {
    due = Math.max(due, ceilingDelayUntil(now, policy.maxPerMinute, recentCount, oldestRecentAt));
  }

  return due;
}

/** Whether an endpoint has asked for any noise control at all. */
export function hasNoisePolicy(policy: NoisePolicy): boolean {
  return (
    (policy.batchWindowSeconds !== null && policy.batchWindowSeconds > 0) ||
    (policy.maxPerMinute !== null && policy.maxPerMinute >= MIN_MAX_PER_MINUTE)
  );
}

/** Clamps an operator-supplied window, or null for "no batching". */
export function normaliseBatchWindow(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_BATCH_WINDOW_SECONDS, Math.round(n));
}

/** Clamps an operator-supplied ceiling, or null for "no ceiling". */
export function normaliseMaxPerMinute(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_MAX_PER_MINUTE) return null;
  return Math.round(n);
}
