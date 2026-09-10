/**
 * Builds the rollups for history the scheduler has not reached yet (F6b).
 *
 * `npm run rollups:backfill [-- --reset] [--chunks 0] [--org 1]`
 *
 * The scheduler already does this, one day every five minutes, deliberately
 * slowly: the worker connection pool is five connections by default and the
 * monitor checks share it, so a greedy backfill would starve the thing the
 * product exists to do. That pace is right for an instance in service and wrong
 * for two situations this script is for:
 *
 *   - **A repair.** Something went wrong and the history needs rebuilding now,
 *     with somebody watching.
 *   - **A migration window.** The instance is not serving anyone, so there is
 *     nothing to be polite to.
 *
 * `--reset` clears `backfill_complete` and the cursor and starts again from the
 * oldest sample. That is the repair button: it takes the read path back to raw
 * SQL - the kill switch - until the walk finishes, so the numbers on the page
 * stay correct while they are being rebuilt rather than going blank.
 */

import knexOb from "../knexfile.js";
import db from "../src/lib/server/db/db.js";
import { runWithOrg } from "../src/lib/server/db/orgContext.js";
import { MERGED_REGION_ID } from "../src/lib/server/db/regions.js";
import { backfillChunk } from "../src/lib/server/services/rollupEngine.js";
import { GetNowTimestampUTC } from "../src/lib/server/tool.js";
import type { RollupGrain } from "../src/lib/server/types/db.js";

function intArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = parseInt(process.argv[index + 1] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");
  // 0 means "keep going until it is done", which is the point of running this by
  // hand rather than waiting for the scheduler.
  const maxChunks = intArg("chunks", 0);
  const onlyOrg = intArg("org", 0);

  console.log(`\n=== rollups:backfill (${knexOb.databaseType}) ===`);

  const orgIds = (await db.getActiveOrgIds()).filter((id: number) => onlyOrg === 0 || id === onlyOrg);
  if (orgIds.length === 0) {
    console.log("No active organisations.");
    await db.close();
    return;
  }

  for (const orgId of orgIds) {
    await runWithOrg(orgId, async () => {
      const nowTs = GetNowTimestampUTC();

      if (reset) {
        for (const grain of ["5m", "1h", "1d"] as RollupGrain[]) {
          await db.upsertRollupState(
            grain,
            MERGED_REGION_ID,
            {
              backfill_complete: false,
              backfill_cursor_ts: null,
              backfill_started_at: nowTs,
              backfill_completed_at: null,
            },
            nowTs,
          );
        }
        console.log(`  org ${orgId}: reset — the read path falls back to raw SQL until this finishes`);
      }

      const bounds = await db.getRawSampleBounds(MERGED_REGION_ID);
      if (!bounds) {
        console.log(`  org ${orgId}: no samples; nothing to backfill`);
        await backfillChunk(MERGED_REGION_ID, nowTs, 1);
        return;
      }

      const state = await db.getRollupState("1h", MERGED_REGION_ID);
      const startCursor = state?.backfill_cursor_ts ?? bounds.lo;
      const target = state?.watermark_ts ?? nowTs;
      const totalDays = Math.max(1, Math.ceil((target - startCursor) / 86400));
      console.log(
        `  org ${orgId}: ${new Date(startCursor * 1000).toISOString()} -> ${new Date(target * 1000).toISOString()} ` +
          `(~${totalDays} day-chunks)`,
      );

      let done = false;
      let processed = 0;
      const started = Date.now();

      while (!done) {
        // One chunk per call, so the cursor is written after each day and an
        // interrupt costs at most one repeated day.
        const progress = await backfillChunk(MERGED_REGION_ID, GetNowTimestampUTC(), 1);
        done = progress.done;
        if (progress.chunksProcessed === 0) break;
        processed += progress.chunksProcessed;

        const pct = Math.min(100, Math.round((processed / totalDays) * 100));
        process.stdout.write(
          `\r  org ${orgId}: ${pct}% — ${processed}/${totalDays} days, ` +
            `cursor ${new Date((progress.cursor ?? 0) * 1000).toISOString().slice(0, 10)}   `,
        );

        if (maxChunks > 0 && processed >= maxChunks) {
          process.stdout.write("\n");
          console.log(`  org ${orgId}: stopped after ${processed} chunk(s) as asked; re-run to continue`);
          return;
        }
      }

      process.stdout.write("\n");
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(
        `  org ${orgId}: ${done ? "COMPLETE" : "stopped"} after ${processed} chunk(s) in ${elapsed}s` +
          `${done ? " — the read path may now use rollups" : ""}`,
      );
    });
  }

  console.log("\nRun `npm run rollups:verify` to check the result against the raw samples.\n");
  await db.close();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await db.close();
  } catch {
    // Already closing, or never opened. Nothing useful to do with a second error.
  }
  process.exit(1);
});
