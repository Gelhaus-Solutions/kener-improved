import { acquireLock, getCacheMany, releaseLock, setCacheMany } from "./cache.js";
import { getRollupVersions } from "./rollupVersion.js";
import { currentOrgId } from "../events/eventContext.js";
import type { TimestampStatusCount } from "../types/db.js";
import { pickGrain, readUptimeBuckets, type UptimeBucketRequest } from "../services/uptimeAggregator.js";

/**
 * Caching uptime buckets, one bucket at a time (I9).
 *
 * **Why the existing cache does not work, which is worth knowing before reading
 * the replacement.** `GetStatusCountsByIntervalGroupedByMonitor` wraps its query
 * in a 60-second cache whose key is
 * `status_counts_grouped:{sorted tags}:{start}:{interval}:{points}`. Three
 * things go wrong with that:
 *
 *   1. `start` is derived from the viewer's `endOfDayTodayAtTz`, so there is one
 *      key per timezone offset per day boundary - roughly thirty-eight live
 *      values at any moment, each a separate full scan.
 *   2. The key contains the whole tag list, so a page showing a different set of
 *      monitors shares nothing with one showing a superset of it.
 *   3. There is no single-flight, so the moment a key expires every concurrent
 *      visitor runs the thirteen-million-row scan at once.
 *
 * **The replacement caches per (monitor, bucket) instead of per response.** A
 * sealed day can never change again, so it is cached for a week; only today's
 * partial bucket is short-lived. A returning visitor's ninety-day bar is
 * eighty-nine cache hits and one computation, and two viewers in different
 * timezones share every bucket whose boundaries happen to line up.
 *
 * **Invalidation is a counter, not a search.** The key carries the monitor's
 * rollup version, which F6b's `markRollupDirty` increments whenever history is
 * rewritten. Old keys simply become unreachable and expire on their own. No
 * `SCAN`, no `DEL` storm, and no window in which a reader can repopulate a key
 * that is about to be deleted.
 */

/** A sealed bucket can never change again, so it is worth keeping for a week. */
const SEALED_TTL_SECONDS = 7 * 24 * 3600;

/** The current, still-moving bucket. Matches the cache it replaces. */
const LIVE_TTL_SECONDS = 60;

/** How long one computation may hold the single-flight lock. */
const LOCK_TTL_SECONDS = 15;

/** How long a loser waits for the winner before computing anyway. */
const LOCK_WAIT_MS = 600;
const LOCK_POLL_MS = 100;

/**
 * `null` and "no data in this bucket" are different answers, and a cache that
 * cannot tell them apart re-computes every empty bucket on every request - which
 * on a young monitor is most of the ninety.
 */
type CachedBucket = { d: TimestampStatusCount } | { e: 1 };

function bucketKey(
  orgId: number | null,
  tag: string,
  version: string,
  grain: string,
  intervalSeconds: number,
  bucketStart: number,
): string {
  // `orgId` is in the key because monitor tags are globally unique *today* and
  // that is a property to rely on deliberately rather than by accident.
  return `bar:${orgId ?? 0}:${tag}:${version}:${grain}:${intervalSeconds}:${bucketStart}`;
}

/**
 * The requested buckets, from cache where possible.
 *
 * Returns null when the rollups cannot serve the request at all, so the caller
 * falls back to the raw query rather than to a wrong answer. Nothing is cached
 * in that case: a fallback result is not the rollup answer and must not be
 * served as one once the rollups do become usable.
 */
export async function getUptimeBucketsCached(
  request: UptimeBucketRequest,
  watermark: number,
): Promise<Map<string, TimestampStatusCount[]> | null> {
  const { monitorTags, startTimestamp, intervalSeconds, points } = request;
  if (monitorTags.length === 0) return new Map();

  const orgId = currentOrgId();
  const grain = pickGrain(startTimestamp, intervalSeconds);
  const versions = await getRollupVersions(monitorTags);

  // ---- one MGET for the whole page ---------------------------------------
  const keys: string[] = [];
  const coords: Array<{ tag: string; index: number }> = [];
  monitorTags.forEach((tag, tagIndex) => {
    for (let index = 0; index < points; index++) {
      keys.push(
        bucketKey(orgId, tag, versions[tagIndex], grain, intervalSeconds, startTimestamp + index * intervalSeconds),
      );
      coords.push({ tag, index });
    }
  });

  const cached = await getCacheMany<CachedBucket>(keys);

  const resolved = new Map<string, Array<TimestampStatusCount | null | undefined>>();
  for (const tag of monitorTags) resolved.set(tag, new Array(points));

  const missingIndexes: number[] = [];
  cached.forEach((value, position) => {
    const { tag, index } = coords[position];
    if (value === null) {
      missingIndexes.push(index);
      return;
    }
    resolved.get(tag)![index] = "e" in value ? null : value.d;
  });

  if (missingIndexes.length === 0) return collect(monitorTags, resolved, startTimestamp, intervalSeconds, points);

  // ---- compute only the span that is actually missing ----------------------
  //
  // For a returning visitor that is one bucket: today's. Recomputing the whole
  // ninety days because the last one expired is exactly the waste the per-bucket
  // keys exist to avoid.
  const firstMissing = Math.min(...missingIndexes);
  const lastMissing = Math.max(...missingIndexes);
  const subRequest: UptimeBucketRequest = {
    monitorTags,
    startTimestamp: startTimestamp + firstMissing * intervalSeconds,
    intervalSeconds,
    points: lastMissing - firstMissing + 1,
  };

  // ---- single flight ------------------------------------------------------
  //
  // Keyed on the span rather than per bucket: a lock per bucket would be nine
  // thousand `SET NX` calls to protect one query, which costs more than the
  // stampede it prevents.
  const lockKey = `bar:${orgId ?? 0}:${grain}:${subRequest.startTimestamp}:${subRequest.points}:${monitorTags.length}`;
  const holdsLock = await acquireLock(lockKey, LOCK_TTL_SECONDS);

  if (!holdsLock) {
    // Somebody else is computing the same span. Wait briefly, then re-read; if
    // it is still not there, compute anyway. **Never block indefinitely** - a
    // lock holder that died leaves the key set for its whole TTL, and a request
    // that waits on it would turn one slow computation into fifteen seconds of
    // stalled page loads.
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      const retry = await getCacheMany<CachedBucket>(keys);
      if (retry.every((value) => value !== null)) {
        retry.forEach((value, position) => {
          const { tag, index } = coords[position];
          resolved.get(tag)![index] = value !== null && "e" in value ? null : (value as { d: TimestampStatusCount }).d;
        });
        return collect(monitorTags, resolved, startTimestamp, intervalSeconds, points);
      }
    }
  }

  try {
    const computed = await readUptimeBuckets(subRequest);
    if (computed === null) return null;

    const toCache: Array<{ key: string; value: CachedBucket; ttlSeconds: number }> = [];
    monitorTags.forEach((tag, tagIndex) => {
      const series = computed.get(tag) ?? [];
      const byTs = new Map(series.map((point) => [point.ts, point]));
      for (let index = firstMissing; index <= lastMissing; index++) {
        const ts = startTimestamp + index * intervalSeconds;
        const point = byTs.get(ts) ?? null;
        resolved.get(tag)![index] = point;
        // Sealed only when the whole bucket is behind the watermark. A bucket
        // that merely *starts* behind it still has minutes that can change, and
        // caching that for a week is how a bar freezes mid-outage.
        const sealed = ts + intervalSeconds <= watermark;
        toCache.push({
          key: bucketKey(orgId, tag, versions[tagIndex], grain, intervalSeconds, ts),
          value: point ? { d: point } : { e: 1 },
          ttlSeconds: sealed ? SEALED_TTL_SECONDS : LIVE_TTL_SECONDS,
        });
      }
    });
    await setCacheMany(toCache);

    return collect(monitorTags, resolved, startTimestamp, intervalSeconds, points);
  } finally {
    if (holdsLock) await releaseLock(lockKey);
  }
}

function collect(
  monitorTags: ReadonlyArray<string>,
  resolved: Map<string, Array<TimestampStatusCount | null | undefined>>,
  startTimestamp: number,
  intervalSeconds: number,
  points: number,
): Map<string, TimestampStatusCount[]> {
  const out = new Map<string, TimestampStatusCount[]>();
  for (const tag of monitorTags) {
    const buckets = resolved.get(tag) ?? [];
    const series: TimestampStatusCount[] = [];
    for (let index = 0; index < points; index++) {
      const point = buckets[index];
      // `undefined` is a bucket nothing filled in, which can only happen if the
      // computation covered a narrower span than the cache miss did. Treated as
      // absent, exactly like an explicit empty.
      if (point === null || point === undefined) continue;
      series.push({ ...point, ts: startTimestamp + index * intervalSeconds });
    }
    out.set(tag, series);
  }
  return out;
}
