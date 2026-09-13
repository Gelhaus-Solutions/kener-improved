/**
 * Recomputes the incident lifecycle timestamps across an instance (KENER-150).
 *
 * `npm run backfill:incident-timeline [-- --org 1]`
 *
 * **Why this is a script and not a migration, which is the whole bug.** The
 * original backfill lived inside migration `20260909170000`, and migrations run
 * before seeds on every path there is: `preseed`, `predev`, and `scripts/main.ts`
 * at lines 85 and 103. On a fresh install it therefore swept an empty
 * `incidents` table, wrote nothing, and knex marked it done for ever. Every
 * incident that arrived afterwards, by seed, by C7 import, or by restoring a
 * dump onto an already migrated schema, kept null timestamps permanently, and
 * the Response Timeline read "Not recorded" on every row with nothing able to
 * recompute it.
 *
 * **The general lesson is worth more than the fix.** A data backfill inside a
 * migration is only ever correct for a database that already held the data when
 * that one migration ran. Any backfill that could matter to an install populated
 * later belongs in a re-runnable routine, with the migration calling it rather
 * than owning it.
 *
 * Safe to run as often as you like: it only ever fills a column that is
 * currently NULL, so it can never overwrite a stamp a live transition or a human
 * produced. The same routine is behind the Recompute button on the incident
 * page, for the operator who notices one incident and should not need a shell.
 */

import knexOb from "../knexfile.js";
import db from "../src/lib/server/db/db.js";
import { runWithOrg } from "../src/lib/server/db/orgContext.js";
import type { LifecycleBackfillCounts } from "../src/lib/server/db/repositories/incidents.js";

function intArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = parseInt(process.argv[index + 1] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function describe(counts: LifecycleBackfillCounts): string {
  const filled = counts.detected_at + counts.identified_at + counts.mitigated_at + counts.resolved_at;
  if (filled === 0) return "nothing to fill";
  // Per column, because "40 values" does not say whether detection was recovered
  // or only resolution was, and those come from different evidence.
  return [
    `${filled} filled`,
    `detected ${counts.detected_at}`,
    `identified ${counts.identified_at}`,
    `mitigated ${counts.mitigated_at}`,
    `resolved ${counts.resolved_at}`,
  ].join(", ");
}

async function main(): Promise<void> {
  const onlyOrg = intArg("org", 0);

  console.log(`\n=== backfill:incident-timeline (${knexOb.databaseType}) ===`);

  const orgIds = (await db.getActiveOrgIds()).filter((id: number) => onlyOrg === 0 || id === onlyOrg);
  if (orgIds.length === 0) {
    console.log("No active organisations.");
    await db.close();
    return;
  }

  const total: LifecycleBackfillCounts = {
    incidents_considered: 0,
    detected_at: 0,
    identified_at: 0,
    mitigated_at: 0,
    resolved_at: 0,
  };

  for (const orgId of orgIds) {
    // Per org rather than one sweep across all of them, so the report says which
    // tenant recovered what and a single org can be repaired on its own.
    const counts = await runWithOrg(orgId, () => db.backfillLifecycleTimestamps());
    console.log(`  org ${orgId}: ${counts.incidents_considered} incomplete, ${describe(counts)}`);

    total.incidents_considered += counts.incidents_considered;
    total.detected_at += counts.detected_at;
    total.identified_at += counts.identified_at;
    total.mitigated_at += counts.mitigated_at;
    total.resolved_at += counts.resolved_at;
  }

  console.log(`\n  total: ${describe(total)}`);
  console.log(
    "\n  acknowledged_at is deliberately never filled: it records that a human took\n" +
      "  ownership, and no historical source for that exists. Deriving it would be\n" +
      "  inventing the MTTA number rather than measuring it.\n",
  );

  await db.close();
}

main().catch(async (error) => {
  console.error(error);
  await db.close();
  process.exit(1);
});
