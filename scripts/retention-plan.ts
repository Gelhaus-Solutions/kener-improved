/**
 * Prints what tonight's retention sweep would delete, and deletes nothing (F6c).
 *
 * `npm run retention:plan [-- --apply] [--org 1]`
 *
 * The nightly scheduler already does this. This exists because retention is the
 * one operation in the data layer that **cannot be undone** - every other
 * mistake in this cycle is repaired by recomputing a bucket - so there has to be
 * a way to look before it runs.
 *
 * `--apply` runs it for real, for the case where an operator has just shortened
 * retention and wants the space back now rather than at midnight.
 */

import knexOb from "../knexfile.js";
import db from "../src/lib/server/db/db.js";
import { runWithOrg } from "../src/lib/server/db/orgContext.js";
import { GetNowTimestampUTC } from "../src/lib/server/tool.js";
import { describeCoverage, effectivePolicy, runRetention } from "../src/lib/server/services/retention.js";
import type { DataRetentionPolicy } from "../src/lib/types/site.js";

function intArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = parseInt(process.argv[index + 1] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const formatDays = (days: number) => (days === 0 ? "forever" : `${days} days`);
const formatCutoff = (cutoff: number | null) =>
  cutoff === null ? "never" : new Date(cutoff * 1000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const onlyOrg = intArg("org", 0);

  console.log(`\n=== retention:${apply ? "apply" : "plan"} (${knexOb.databaseType}) ===`);
  if (apply) console.log("  APPLYING. This deletes data.\n");

  const orgIds = (await db.getActiveOrgIds()).filter((id: number) => onlyOrg === 0 || id === onlyOrg);

  for (const orgId of orgIds) {
    await runWithOrg(orgId, async () => {
      const nowTs = GetNowTimestampUTC();

      const stored = await db.getSiteDataByKey("dataRetentionPolicy");
      let policy: DataRetentionPolicy = { enabled: true, retentionDays: 90 };
      if (stored?.value) {
        try {
          policy = { ...policy, ...(JSON.parse(stored.value) as Partial<DataRetentionPolicy>) };
        } catch {
          console.warn(`  org ${orgId}: dataRetentionPolicy will not parse; using defaults`);
        }
      }

      const { effective, clamped } = effectivePolicy(policy);
      console.log(`\n  org ${orgId}: ${policy.enabled ? "enabled" : "DISABLED"}`);
      console.log(
        `    raw ${formatDays(effective.retentionDays)}, 5m ${formatDays(effective.rollup5mRetentionDays)}, ` +
          `1h ${formatDays(effective.rollup1hRetentionDays)}, 1d ${formatDays(effective.rollup1dRetentionDays)}`,
      );
      for (const note of clamped) console.log(`    adjusted: ${note}`);

      const coverage = describeCoverage(effective, 365);
      console.log(
        `    bar coverage: every timezone ${formatDays(coverage.allTimezonesDays)}, ` +
          `whole-hour ${formatDays(coverage.wholeHourTimezonesDays)}, UTC ${formatDays(coverage.utcDays)}`,
      );

      if (!policy.enabled) {
        console.log("    retention is disabled; nothing would be removed");
        return;
      }

      const run = await runRetention(policy, nowTs, !apply);
      for (const stage of run.stages) {
        if (stage.skipped) {
          const marker = stage.skipped === "kept forever" ? "     " : "  !! ";
          console.log(`  ${marker}${stage.label.padEnd(4)} skipped - ${stage.skipped}`);
          continue;
        }
        const partitions =
          stage.partitionsToDrop.length > 0 ? `, ${stage.partitionsToDrop.length} partition(s) dropped whole` : "";
        const count = apply ? stage.rowsDeleted : stage.rowsToDelete;
        console.log(
          `       ${stage.label.padEnd(4)} ${String(count).padStart(12)} row(s) before ${formatCutoff(stage.cutoff)}${partitions}`,
        );
        if (stage.partitionsToDrop.length > 0) {
          for (const name of stage.partitionsToDrop) console.log(`              ${name}`);
        }
      }
    });
  }

  console.log(apply ? "\nDone.\n" : "\nNothing was deleted. Re-run with --apply to do it for real.\n");
  await db.close();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await db.close();
  } catch {
    // Already closing, or never opened.
  }
  process.exit(1);
});
