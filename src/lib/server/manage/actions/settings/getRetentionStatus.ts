import db from "$lib/server/db/db.js";
import GC from "$lib/global-constants.js";
import { MERGED_REGION_ID } from "$lib/server/db/regions.js";
import { describeCoverage, effectivePolicy, runRetention } from "$lib/server/services/retention.js";
import { GetNowTimestampUTC } from "$lib/server/tool.js";
import type { DataRetentionPolicy } from "$lib/types/site.js";
import type { ActionDefinition } from "../../types.js";

/**
 * What retention would delete tonight, and what the bars can still show (F6c).
 *
 * **A dry run, always.** This is the read half of retention: it computes the
 * same plan the nightly sweep computes and returns it without writing anything.
 * The acceptance for F6c is that a dry run says exactly what a real run would
 * remove, which is only true if both go through `runRetention` - so they do,
 * with one boolean between them.
 *
 * It exists because the interesting part of retention is not a number in a form.
 * It is the answer to three questions an operator cannot get anywhere else:
 * *is it safe to delete raw yet*, *how much would go*, and *how long a bar can I
 * still serve afterwards* - the last of which has a different answer per viewer
 * timezone, and used to have no answer at all.
 */
export default {
  action: "getRetentionStatus",
  handler: async () => {
    const nowTs = GetNowTimestampUTC();

    const stored = await db.getSiteDataByKey("dataRetentionPolicy");
    let policy: DataRetentionPolicy = { enabled: true, retentionDays: 90 };
    if (stored?.value) {
      try {
        policy = { ...policy, ...(JSON.parse(stored.value) as Partial<DataRetentionPolicy>) };
      } catch {
        // A corrupt policy row should not make this screen unreachable; the
        // defaults are what the scheduler would fall back to anyway.
      }
    }

    const { effective, clamped } = effectivePolicy(policy);
    const plan = await runRetention(policy, nowTs, true);

    // The longest history any page is configured to show, which is the number
    // the truncation warning is about: a page advertising 365 days while
    // retention keeps 90 is the silent bug F6c exists to surface. It lives per
    // page inside `page_settings_json`, with desktop and mobile configured
    // separately, so the longest of all of them is what can be truncated.
    //
    // Typed `number` rather than inferred: `GC.DEFAULT_STATUS_HISTORY_DAYS_DESKTOP`
    // is a literal 90 in a const object, so inference would narrow this to the
    // type `90` and reject every other value.
    const pages = await db.getAllPages();
    let longestConfiguredBarDays: number = GC.DEFAULT_STATUS_HISTORY_DAYS_DESKTOP;
    for (const page of pages as Array<{ page_settings_json?: string | null }>) {
      if (!page.page_settings_json) continue;
      try {
        const settings = JSON.parse(page.page_settings_json) as {
          monitor_status_history_days?: { desktop?: number; mobile?: number };
        };
        for (const days of [
          settings.monitor_status_history_days?.desktop,
          settings.monitor_status_history_days?.mobile,
        ]) {
          if (Number.isFinite(Number(days)) && Number(days) > longestConfiguredBarDays) {
            longestConfiguredBarDays = Number(days);
          }
        }
      } catch {
        // A page whose settings will not parse renders with the defaults, so it
        // contributes the default here too rather than failing this screen.
      }
    }

    const coverage = describeCoverage(effective, longestConfiguredBarDays);

    const rollupStates = await Promise.all(
      (["5m", "15m", "1h", "1d"] as const).map(async (grain) => {
        const state = await db.getRollupState(grain, MERGED_REGION_ID);
        return {
          grain,
          watermark_ts: state?.watermark_ts ?? null,
          backfill_complete: !!state?.backfill_complete,
          backfill_cursor_ts: state?.backfill_cursor_ts ?? null,
        };
      }),
    );

    return {
      effective,
      clamped,
      coverage,
      rollupStates,
      dirtyHours: await db.countDirtyHours(),
      stages: plan.stages.map((stage) => ({
        label: stage.label,
        table: stage.table,
        cutoff: stage.cutoff,
        rowsToDelete: stage.rowsToDelete,
        partitionsToDrop: stage.partitionsToDrop,
        skipped: stage.skipped,
      })),
    };
  },
} satisfies ActionDefinition;
