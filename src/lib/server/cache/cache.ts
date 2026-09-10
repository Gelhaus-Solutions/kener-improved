import { redisIOConnection } from "../redisConnector.js";

const prefix = "kener:cache:";
const defaultTtlSeconds = 300;

const getCacheKey = (key: string) => `${prefix}${key}`;

export async function setCache<T>(key: string, value: T | null | undefined, ttlSeconds?: number): Promise<void> {
  const redis = redisIOConnection();
  const payload = JSON.stringify(value ?? null);

  const ttl = typeof ttlSeconds === "number" && ttlSeconds > 0 ? ttlSeconds : defaultTtlSeconds;
  await redis.set(getCacheKey(key), payload, "EX", ttl);
}

export async function deleteCache(key: string): Promise<void> {
  const redis = redisIOConnection();
  await redis.del(getCacheKey(key));
}

/**
 * Reads many keys in one round trip.
 *
 * The 90-day bar for a hundred monitors is nine thousand cache keys. One key per
 * `GET` is nine thousand round trips, which on any network at all costs more
 * than the query the cache exists to avoid - so the batched read is not an
 * optimisation here, it is what makes per-bucket caching viable at all.
 *
 * Chunked, because a single `MGET` with nine thousand arguments is one enormous
 * command that blocks the Redis event loop for everything else.
 *
 * A missing or unparseable key comes back as `null`, indistinguishable from a
 * miss on purpose: a corrupt cache entry should cost a recomputation, not a
 * request.
 */
export async function getCacheMany<T>(keys: ReadonlyArray<string>): Promise<Array<T | null>> {
  if (keys.length === 0) return [];
  const redis = redisIOConnection();
  const out: Array<T | null> = [];
  const chunkSize = 500;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize).map(getCacheKey);
    const values = await redis.mget(chunk);
    for (const value of values) {
      if (value === null) {
        out.push(null);
        continue;
      }
      try {
        out.push(JSON.parse(value) as T);
      } catch {
        out.push(null);
      }
    }
  }
  return out;
}

/**
 * Writes many keys in one round trip, each with its own TTL.
 *
 * Per-entry TTL rather than one for the batch, because the caller mixes two
 * kinds of entry: a sealed day that can never change again and today's partial
 * one that changes every minute. Giving them the same lifetime would mean either
 * re-fetching ninety immutable days every minute or showing a stale current day
 * for a week.
 */
export async function setCacheMany<T>(
  entries: ReadonlyArray<{ key: string; value: T; ttlSeconds: number }>,
): Promise<void> {
  if (entries.length === 0) return;
  const redis = redisIOConnection();
  const chunkSize = 500;
  for (let i = 0; i < entries.length; i += chunkSize) {
    const pipeline = redis.pipeline();
    for (const entry of entries.slice(i, i + chunkSize)) {
      const ttl = entry.ttlSeconds > 0 ? entry.ttlSeconds : defaultTtlSeconds;
      pipeline.set(getCacheKey(entry.key), JSON.stringify(entry.value ?? null), "EX", ttl);
    }
    await pipeline.exec();
  }
}

/**
 * Takes a short lock, or reports that somebody else holds it.
 *
 * `SET NX EX`: the one Redis primitive that is both atomic and self-expiring, so
 * a process that dies holding the lock releases it by timeout rather than
 * wedging the key forever.
 */
export async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  const redis = redisIOConnection();
  const result = await redis.set(getCacheKey(`lock:${key}`), "1", "EX", Math.max(1, ttlSeconds), "NX");
  return result === "OK";
}

export async function releaseLock(key: string): Promise<void> {
  await deleteCache(`lock:${key}`);
}

export async function getCache<T>(
  key: string,
  fetcher?: () => Promise<T | null | undefined> | T | null | undefined,
  ttlSeconds?: number,
): Promise<T | null> {
  const redis = redisIOConnection();
  const raw = await redis.get(getCacheKey(key));
  if (raw !== null) {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  if (!fetcher) return null;

  const value = await fetcher();
  await setCache<T>(key, value, ttlSeconds);
  return value ?? null;
}
