import type { SiteDataTransformed } from "../controllers/siteDataController.js";
import { getCache, setCache, deleteCache } from "./cache.js";

// Cache for the whole transformed site_data table.
//
// GetAllSiteData() is the hottest read in the app: every public page load goes
// through GetLayoutServerData, which reads all ~57 site_data rows and JSON.parses
// every row whose data_type is "object". The parsed result is what gets cached,
// not the raw rows, so a hit skips the parsing as well as the query.
//
// Two layers, because they solve different problems:
//
//   memo (5s, in-process)  removes Redis I/O from the common case entirely.
//   Redis (300s, shared)   survives a process restart and is shared by the web
//                          and scheduler processes.
//
// A write invalidates both. The memo is per-process, so in the dev two-process
// setup a write in one process leaves the other's memo warm for up to 5 seconds.
// That is the intended staleness budget for site configuration.

const MEMO_TTL_MS = 5_000;
const REDIS_TTL_SECONDS = 300;

// Redis is configured with maxRetriesPerRequest: null (BullMQ requires it), so a
// command issued while Redis is unreachable sits in the offline queue instead of
// failing. On this path that would hang every page load, so each Redis call gets
// a deadline and falls through to the database when it expires.
const REDIS_DEADLINE_MS = 1_000;

/**
 * The cache key. A function rather than a constant because P4 makes site_data
 * org-scoped, at which point this becomes `site_data:all:${orgId}` and every
 * call site keeps working.
 */
export function siteDataCacheKey(): string {
  return "site_data:all";
}

let memo: { value: SiteDataTransformed; expiresAt: number } | null = null;

// Redis being down should produce one line a minute, not one line per request.
let lastWarnAt = 0;
function warnThrottled(action: string, err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  console.warn(`site data cache: ${action} failed, falling back to the database:`, err);
}

function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis did not answer within ${REDIS_DEADLINE_MS}ms`)), REDIS_DEADLINE_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Returns the transformed site data, reading through the memo and Redis and
 * falling back to `load` on a miss.
 *
 * Fails open: any cache error is logged and answered from `load`, so a Redis
 * outage degrades this to the behaviour it had before caching existed rather
 * than taking the site down.
 */
export async function GetSiteDataCached(load: () => Promise<SiteDataTransformed>): Promise<SiteDataTransformed> {
  if (memo && memo.expiresAt > Date.now()) {
    return memo.value;
  }

  try {
    const cached = await withDeadline(getCache<SiteDataTransformed>(siteDataCacheKey()));
    if (cached) {
      memo = { value: cached, expiresAt: Date.now() + MEMO_TTL_MS };
      return cached;
    }
  } catch (err) {
    warnThrottled("read", err);
  }

  const fresh = await load();

  try {
    await withDeadline(setCache<SiteDataTransformed>(siteDataCacheKey(), fresh, REDIS_TTL_SECONDS));
  } catch (err) {
    warnThrottled("write", err);
  }

  // Memoise even when Redis is unavailable: 5 seconds of in-process caching is
  // exactly when it is most worth having.
  memo = { value: fresh, expiresAt: Date.now() + MEMO_TTL_MS };
  return fresh;
}

/**
 * Drops both layers. Call after any write to site_data.
 *
 * Never throws: a failed invalidation means stale config for up to the Redis
 * TTL, which must not turn a settings save into an error response.
 */
export async function InvalidateSiteDataCache(): Promise<void> {
  memo = null;
  try {
    await withDeadline(deleteCache(siteDataCacheKey()));
  } catch (err) {
    console.warn("site data cache: invalidation failed, config may be stale until the TTL expires:", err);
  }
}
