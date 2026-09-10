import type { Knex } from "knex";
import { requireOrgId } from "./orgContext.js";
import { afterCommit } from "./trxContext.js";
import { bumpRollupVersion } from "../cache/rollupVersion.js";

/**
 * Marking rollup buckets for recomputation (F6b).
 *
 * A free function rather than a repository method, because the three callers
 * that matter live in `MonitoringRepository` and have to mark **inside their own
 * transaction**. Reaching across to another repository from in there would mean
 * either threading a transaction by hand or hoping the ambient one is picked up
 * by a builder constructed elsewhere; a function that takes the connection it is
 * given has neither problem.
 *
 * **The unit is an hour.** See the migration for why: a per-bucket set does not
 * survive a C7 backfill rewriting 100,000 minutes in one transaction.
 *
 * **`org_id` is stamped explicitly here, and that is not optional.** These
 * callers write through `knexUnscoped` because they are inside a transaction,
 * and the scoped builder is also what stamps the org. A row written without it
 * lands with a null `org_id`, `rollup_dirty` is a tenant table read as
 * `where org_id = ?`, and nothing would ever drain it - the recompute would
 * simply never happen and the bars would quietly go stale. That is the exact
 * shape of the bug B1a found in `updateMonitoringData`.
 */

export const HOUR_SECONDS = 3600;

/** The start of the UTC hour containing `ts`. Integer arithmetic, never a Date. */
export function hourStartFor(ts: number): number {
  return Math.floor(ts / HOUR_SECONDS) * HOUR_SECONDS;
}

/**
 * The largest number of hours one call will mark.
 *
 * A guard rather than a limit anybody should hit: C7's backfill caps at 90 days,
 * which is 2,160 hours. Beyond this the caller is rewriting so much history that
 * a full recompute is the cheaper answer, and silently marking a million rows
 * would be the worse failure.
 */
export const MAX_DIRTY_HOURS_PER_CALL = 20000;

export interface DirtyRange {
  monitor_tag: string;
  region_id: number;
  /** Inclusive, in UTC seconds. */
  from: number;
  /** Inclusive, in UTC seconds. */
  to: number;
}

/**
 * Marks every hour touched by each range, so the rollup scheduler recomputes it.
 *
 * Idempotent: the whole row is the primary key, so replaying a BullMQ job that
 * already marked these hours inserts nothing.
 *
 * Bumps the per-monitor cache version **after the transaction commits**, never
 * inside it. A version bumped inside a transaction that then rolls back would
 * have invalidated a cache entry that was still correct, and - worse - a bump
 * that happens before the commit lets a reader repopulate the cache from the old
 * rows and then see no further invalidation.
 */
export async function markRollupDirty(knex: Knex, ranges: ReadonlyArray<DirtyRange>, nowTs: number): Promise<number> {
  if (ranges.length === 0) return 0;

  // Null under `runAsSystem`, the deliberate cross-tenant mode. Nothing to mark
  // in that case: a dirty row with no org could never be drained.
  const orgId = requireOrgId("rollup_dirty");
  if (orgId === null) return 0;

  const rows: Array<{
    org_id: number;
    monitor_tag: string;
    region_id: number;
    hour_start: number;
    marked_at: number;
  }> = [];
  const tags = new Set<string>();

  for (const range of ranges) {
    if (range.to < range.from) continue;
    const first = hourStartFor(range.from);
    const last = hourStartFor(range.to);
    const hours = (last - first) / HOUR_SECONDS + 1;
    if (hours > MAX_DIRTY_HOURS_PER_CALL) {
      throw new Error(
        `Refusing to mark ${hours} hours dirty for ${range.monitor_tag}; the cap is ${MAX_DIRTY_HOURS_PER_CALL}. ` +
          `Rewriting this much history should go through a rollup backfill instead.`,
      );
    }
    tags.add(range.monitor_tag);
    for (let hour = first; hour <= last; hour += HOUR_SECONDS) {
      rows.push({
        org_id: orgId,
        monitor_tag: range.monitor_tag,
        region_id: range.region_id,
        hour_start: hour,
        marked_at: nowTs,
      });
    }
  }

  if (rows.length === 0) return 0;

  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    await knex("rollup_dirty")
      .insert(rows.slice(i, i + batchSize))
      // Already marked and not yet drained: nothing to change. Keeping the
      // original `marked_at` also means the drain's oldest-first order reflects
      // when the invalidation actually happened.
      .onConflict(["org_id", "monitor_tag", "region_id", "hour_start"])
      .ignore();
  }

  afterCommit(async () => {
    for (const tag of tags) await bumpRollupVersion(tag);
  });

  return rows.length;
}
