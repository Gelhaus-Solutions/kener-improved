import { currentOrgIdOrDefault } from "../db/orgContext.js";
import { GetSiteDataByKey } from "../controllers/siteDataController.js";
import type { ConsumerMode } from "./types.js";

// What each consumer is currently allowed to do, read from `site_data`.
//
// This is the strangler switch. Moving a notification channel onto the bus is
// the change in this project most likely to lose messages silently, because the
// failure mode is not an error anywhere: it is a customer who does not get an
// email and says nothing for a week. A flag that can be flipped back in seconds,
// without a deploy, is what makes that risk affordable, and a shadow mode that
// records what *would* have been sent is what turns "we think it matches" into
// evidence.
//
// The four modes, in increasing order of commitment:
//
//   off      no delivery rows at all. The consumer may as well not exist.
//   legacy   a SKIPPED row per target, and nothing else. The old inline code
//            still does the work. Zero behaviour change, but the log now says
//            who *would* have been notified, which is the cheapest evidence
//            available and costs one row per target to collect.
//   shadow   full target resolution and, for a consumer that supports it, the
//            fully rendered request body - recorded as a SHADOW row and never
//            sent. The old code still sends. This is the row you diff.
//   live     the consumer sends for real.
//
// `legacy` is not the same as `off` and the difference is the whole point: `off`
// tells you nothing, `legacy` tells you what the new path would have selected
// while risking nothing at all.

const SITE_DATA_KEY = "eventBusConsumers";

/**
 * How long a read is reused.
 *
 * Ten seconds is the number from the H8c plan and it is the right order of
 * magnitude for both directions: short enough that an operator flipping a
 * consumer back after a bad deploy sees it take effect while they are still
 * looking at the screen, and long enough that the relay's one-second tick is not
 * issuing six reads a minute for a value that changes monthly.
 *
 * Deliberately not wired to `InvalidateSiteDataCache`. This cache is per
 * process, the scheduler and the web process are separate processes, and an
 * invalidation that only reached one of them would be worse than no
 * invalidation: it would make the staleness inconsistent instead of merely
 * bounded, and a ten-second bound that always holds is easier to reason about
 * than a cache that is usually instant.
 */
const CACHE_TTL_MS = 10_000;

const VALID_MODES: ReadonlySet<string> = new Set<ConsumerMode>(["off", "legacy", "shadow", "live"]);

const cache = new Map<number, { value: Record<string, ConsumerMode>; expiresAt: number }>();

function parseModes(raw: unknown): Record<string, ConsumerMode> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ConsumerMode> = {};
  for (const [name, mode] of Object.entries(raw as Record<string, unknown>)) {
    // An unrecognised mode is dropped rather than coerced. Coercing it would
    // have to pick a direction, and both directions are wrong: guessing `live`
    // could start sending from a typo, guessing `off` could silently stop a
    // channel that was working. Dropping it falls back to the consumer's own
    // declared default, which is a value somebody chose on purpose.
    if (typeof mode === "string" && VALID_MODES.has(mode)) {
      out[name] = mode as ConsumerMode;
    } else {
      console.warn(`event consumer modes: ignoring unrecognised mode "${String(mode)}" for "${name}"`);
    }
  }
  return out;
}

async function load(): Promise<Record<string, ConsumerMode>> {
  // Keyed by org (I3d). `eventBusConsumers` is a `site_data` row and `site_data`
  // is per-org as of I3b, so a single cache slot would hand one tenant's mode
  // decisions to every other - and these decide whether customer notifications
  // are sent at all. Exactly the leak `siteDataCache.ts` had, in a file that is
  // read on every relay tick rather than every page load.
  const orgId = currentOrgIdOrDefault();

  const hit = cache.get(orgId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let value: Record<string, ConsumerMode>;
  try {
    value = parseModes(await GetSiteDataByKey(SITE_DATA_KEY));
  } catch (error) {
    // The database is unreachable. Answering with an empty map sends every
    // consumer to its declared default, which is the state the code shipped in.
    // Caching that briefly is deliberate: without it, a database outage would
    // put one extra failing query on every relay tick and every dispatch.
    console.error("event consumer modes: could not read site_data, using declared defaults:", error);
    value = {};
  }

  cache.set(orgId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * The mode `name` is running in, falling back to the consumer's own default.
 *
 * The fallback matters on a fresh install and on any install whose flag predates
 * a newly added consumer: a consumer missing from the row runs as its author
 * declared it, never as `off`. A new consumer that silently did nothing until
 * somebody noticed the flag was incomplete is exactly the bug this avoids.
 */
export async function consumerMode(name: string, declared: ConsumerMode): Promise<ConsumerMode> {
  return (await load())[name] ?? declared;
}

/** Every mode currently configured, for the admin screen. Never falls back. */
export async function configuredModes(): Promise<Record<string, ConsumerMode>> {
  return { ...(await load()) };
}

/**
 * Drops the cache.
 *
 * Called by the action that writes a mode, so the process that served the click
 * reflects it immediately rather than after the TTL. The *other* process still
 * waits out its own ten seconds, which is why the TTL is the contract and this
 * is only a courtesy.
 */
export function invalidateConsumerModes(): void {
  // Every org, not just the current one. This is a courtesy path rather than the
  // contract - the TTL is - and clearing one entry while leaving the others
  // would make the staleness inconsistent between tenants, which is harder to
  // reason about than clearing the lot.
  cache.clear();
}

export { SITE_DATA_KEY as CONSUMER_MODES_KEY };
