import { redisIOConnection } from "../redisConnector.js";

// Index of which monitor tags have at least one active alert config.
//
// alertingQueue.push() runs for every stored datapoint of every monitor every
// minute. Before this index it issued GetMonitorsParsed + GetMonitorAlertConfigs
// and then returned early when there were no configs, which is the common case:
// two throwaway queries per monitor-minute, on the worker pool that defaults to
// five connections. This turns that into one SISMEMBER.
//
// FAIL OPEN. A missed alert is far worse than a wasted query, so every failure
// mode here answers "maybe" and lets push() do the real queries:
//
//   - Redis unreachable, slow, or erroring  -> maybe
//   - index never built, or gone stale      -> maybe
//
// "Stale" is the case a plain set cannot express. An empty set and a missing key
// are the same thing in Redis, and an empty set is precisely the state this
// optimises for (nobody has configured an alert). So a separate marker key says
// "the index is built and current", and it carries a TTL of a few scheduler
// ticks. If the process that rebuilds it stops, the marker expires and we go
// back to querying instead of trusting a frozen index.

const TAGS_KEY = "kener:alertcfg:tags";
const MARKER_KEY = "kener:alertcfg:built";

// appScheduler rebuilds every 10s; the marker outlives a few missed ticks so a
// slow tick does not flap the index off, but a dead scheduler expires it.
const MARKER_TTL_SECONDS = 60;

// Redis is configured with maxRetriesPerRequest: null, so a command issued while
// Redis is unreachable waits in the offline queue rather than failing. This runs
// on the hot path, so give it a deadline and treat expiry as "maybe".
const DEADLINE_MS = 500;

let lastWarnAt = 0;
function warnThrottled(action: string, err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  console.warn(`alert config index: ${action} failed, evaluating alerts without it:`, err);
}

function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis did not answer within ${DEADLINE_MS}ms`)), DEADLINE_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Replaces the index with `tags` and marks it current.
 *
 * The swap is a single MULTI so a reader never sees a half-written set. Called
 * from the appScheduler tick; failures are logged and ignored, since a stale
 * marker simply expires into fail-open.
 */
export async function RebuildAlertConfigTagIndex(tags: string[]): Promise<void> {
  try {
    const redis = redisIOConnection();
    const tx = redis.multi().del(TAGS_KEY);
    if (tags.length > 0) {
      tx.sadd(TAGS_KEY, ...tags);
    }
    tx.set(MARKER_KEY, "1", "EX", MARKER_TTL_SECONDS);
    await withDeadline(tx.exec());
  } catch (err) {
    warnThrottled("rebuild", err);
  }
}

/**
 * Marks the index out of date, so reads fail open until the next rebuild.
 *
 * Call after any write that changes which tags have an active alert config.
 * Dropping only the marker, and not the set, means the worst case is up to one
 * scheduler tick of unnecessary queries. Dropping the set instead would be the
 * same cost with more to go wrong.
 */
export async function InvalidateAlertConfigTagIndex(): Promise<void> {
  try {
    const redis = redisIOConnection();
    await withDeadline(redis.del(MARKER_KEY));
  } catch (err) {
    warnThrottled("invalidation", err);
  }
}

/**
 * Whether `tag` might have an active alert config.
 *
 * `false` is a definite answer, produced only from a current index, and is the
 * only case where the caller may skip evaluation. Everything else returns
 * `true`, including every error path.
 */
export async function MayHaveAlertConfig(tag: string): Promise<boolean> {
  try {
    const redis = redisIOConnection();
    const results = await withDeadline(redis.multi().exists(MARKER_KEY).sismember(TAGS_KEY, tag).exec());
    if (!results || results.length !== 2) return true;

    const [markerErr, markerValue] = results[0];
    const [memberErr, memberValue] = results[1];
    if (markerErr || memberErr) return true;

    // No marker means the index is missing or stale; do not trust the set.
    if (Number(markerValue) !== 1) return true;

    return Number(memberValue) === 1;
  } catch (err) {
    warnThrottled("read", err);
    return true;
  }
}
