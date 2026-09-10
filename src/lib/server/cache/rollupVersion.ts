import { redisIOConnection } from "../redisConnector.js";

/**
 * The per-monitor rollup cache version (F6b).
 *
 * **This exists so cache invalidation is a counter rather than a search.** The
 * read path I9 will build caches per monitor and per day - roughly 90 keys for
 * one monitor's bar, times a key per timezone offset - so invalidating "this
 * monitor's cached numbers" by finding and deleting the affected keys means a
 * `SCAN` over the keyspace and a `DEL` storm, on the hot path, every time a
 * confirmation flip rewrites three minutes of history.
 *
 * Instead the version is part of every cache key. Bumping it makes every old key
 * for that monitor unreachable in one `INCR`, and Redis expires them on their own
 * TTL. Nothing is searched and nothing is deleted.
 *
 * **A failure here is deliberately swallowed.** The bump runs after a database
 * transaction has already committed, so there is nothing left to undo, and
 * failing the caller would misreport durable work as lost. The cost of a missed
 * bump is a stale bar until the key's TTL runs out, which is the same staleness
 * the cache already accepts; the cost of throwing would be a monitor check that
 * reports failure after having succeeded.
 */

const VERSION_PREFIX = "kener:cache:rollupver:";

const versionKey = (monitorTag: string) => `${VERSION_PREFIX}${monitorTag}`;

/** Makes every cache key carrying the old version unreachable. Never throws. */
export async function bumpRollupVersion(monitorTag: string): Promise<void> {
  try {
    await redisIOConnection().incr(versionKey(monitorTag));
  } catch (error) {
    console.error(`Failed to bump the rollup cache version for ${monitorTag}:`, error);
  }
}

/**
 * The current version for a monitor, as a string to go straight into a key.
 *
 * `"0"` when Redis has never seen this monitor, and `"0"` again if Redis is
 * unreachable. The second case is the interesting one: falling back to a
 * constant means a Redis outage degrades to *one shared cache generation*
 * rather than to a cache miss storm or an exception on the render path.
 */
export async function getRollupVersion(monitorTag: string): Promise<string> {
  try {
    const value = await redisIOConnection().get(versionKey(monitorTag));
    return value ?? "0";
  } catch (error) {
    console.error(`Failed to read the rollup cache version for ${monitorTag}:`, error);
    return "0";
  }
}

/** The versions for several monitors at once, in the order asked. One round trip. */
export async function getRollupVersions(monitorTags: ReadonlyArray<string>): Promise<string[]> {
  if (monitorTags.length === 0) return [];
  try {
    const values = await redisIOConnection().mget(monitorTags.map(versionKey));
    return values.map((value) => value ?? "0");
  } catch (error) {
    console.error("Failed to read rollup cache versions:", error);
    return monitorTags.map(() => "0");
  }
}
