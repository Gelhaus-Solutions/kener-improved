// The retry ladder for one delivery.
//
// This lives in the database (event_deliveries.next_attempt_at) rather than in
// BullMQ, and that is a deliberate reversal of how the rest of Kener retries.
// The global default in q.ts is three attempts over roughly 35 seconds, which is
// right for an internal job that failed on a blip and wrong for a customer's
// webhook endpoint: a receiver that is down for a deploy needs minutes, and one
// down for an incident of its own needs hours. Encoding that as BullMQ attempts
// would mean a job sitting in Redis for six hours holding a worker slot.
//
// So the dispatch queue runs with `attempts: 1` and each failure schedules the
// next attempt as a timestamp. The sweeper picks it up when it comes due.

/**
 * The gaps *between* attempts, in seconds. Six gaps, so seven attempts, then the
 * delivery is DEAD.
 *
 * Roughly nine hours end to end: long enough to ride out a receiver's own
 * incident, short enough that a genuinely dead endpoint stops consuming the
 * queue by the end of the working day.
 */
const LADDER_SECONDS = [10, 60, 5 * 60, 30 * 60, 2 * 60 * 60, 6 * 60 * 60];

/** Attempts, not gaps: the first try plus one per rung. */
export const MAX_DELIVERY_ATTEMPTS = LADDER_SECONDS.length + 1;

/**
 * Up to 20% added, never subtracted.
 *
 * Jitter matters more here than in a typical backoff: when a popular endpoint
 * goes down, every delivery to it fails within the same second and would
 * otherwise retry in the same second, turning the retry into a synchronised
 * burst against a host that is already struggling. Spreading only forwards keeps
 * the ladder's guarantees intact.
 */
function jitter(seconds: number): number {
  return Math.round(seconds * (1 + Math.random() * 0.2));
}

/**
 * When to try again after `attempts` failures, or null when the ladder is
 * exhausted and the delivery should go DEAD.
 *
 * `attempts` is the number already made, so the first failure passes 1.
 */
export function nextAttemptAt(attempts: number, now: number): number | null {
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return null;
  const base = LADDER_SECONDS[attempts - 1] ?? LADDER_SECONDS[0];
  return now + jitter(base);
}

/** The ladder, for tests and for showing an operator what to expect. */
export function ladderSeconds(): readonly number[] {
  return LADDER_SECONDS;
}
