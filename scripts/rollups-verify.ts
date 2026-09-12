/**
 * Checks the rollups against the raw samples they claim to summarise (F6b).
 *
 * `npm run rollups:verify [-- --samples 40] [--days 90]`
 *
 * **This is the acceptance test for the whole data layer.** Everything else in
 * P5 is machinery for producing these numbers faster; this asks whether the fast
 * numbers are the same as the slow ones.
 *
 * It picks random (monitor, day) pairs that have samples, computes the day's
 * counts **in SQL, straight from `monitoring_data`**, and compares them column
 * by column against the stored daily rollup. The SQL is deliberately not the
 * aggregation code under test: a check written with `aggregateSamples` would
 * agree with that function's own mistakes, which is the one thing a verifier
 * must not do.
 *
 * It then checks the grains against each other - that a day equals the sum of
 * its twenty-four hours, and an hour the sum of its twelve five-minute buckets -
 * because a fold that drifts is invisible from the raw comparison alone once the
 * finest grain is right.
 *
 * Exits non-zero on any mismatch, so it can be a deploy gate.
 */

import knexLib from "knex";
import type { Knex } from "knex";
import knexOb from "../knexfile.js";
import { LATENCY_TYPES, OVERLAY_TYPES, grainsInFoldOrder } from "../src/lib/server/services/rollupCompute.js";
import { ROLLUP_GRAIN_SECONDS, ROLLUP_TABLES, type RollupGrain } from "../src/lib/server/types/db.js";

const DAY = 86400;
const HOUR = 3600;

/**
 * Which sample types count as overlay and which carry a real latency.
 *
 * **Imported, not written out again, and that is a narrower exception than it
 * looks.** The point of this script is that the arithmetic is independent - the
 * counting happens in SQL precisely so it cannot agree with `aggregateSamples`
 * about a mistake. But *which types exist* is a definition, not arithmetic, and
 * a second copy of a definition is only ever a way to be out of date: KENER-123
 * added `OPERATOR` to the overlay set and this file kept its own list, so the
 * verifier reported two failures a day against an engine that was right.
 *
 * The independence that matters is preserved. These two sets say what the words
 * mean; the SQL below still does its own counting.
 */
const overlayTypes = [...OVERLAY_TYPES];
const latencyTypes = [...LATENCY_TYPES];
const placeholders = (values: ReadonlyArray<unknown>) => values.map(() => "?").join(",");

/** Every grain finer than a day, which is what a daily bucket is the sum of. */
const subDayGrains: RollupGrain[] = grainsInFoldOrder().filter((grain) => ROLLUP_GRAIN_SECONDS[grain] < DAY);

let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }
};

function intArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = parseInt(process.argv[index + 1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const isPg = knexOb.databaseType === "postgresql";

/** SQLite has no FLOOR(); CAST(x AS INT) truncates the same way for non-negative input. */
const floorExpr = (expression: string) => (isPg ? `FLOOR(${expression})` : `CAST(${expression} AS INT)`);

async function rows(
  knex: Knex,
  sql: string,
  bindings: Knex.RawBinding[] = [],
): Promise<Array<Record<string, unknown>>> {
  const result = await knex.raw(sql, bindings);
  if (Array.isArray(result)) return (Array.isArray(result[0]) ? result[0] : result) as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<Record<string, unknown>>;
}

const n = (value: unknown): number => Number(value ?? 0);

async function main(): Promise<void> {
  const sampleCount = intArg("samples", 40);
  const windowDays = intArg("days", 90);

  const knex = knexLib(knexOb as unknown as Knex.Config);
  console.log(`\n=== rollups:verify (${knexOb.databaseType}) ===`);

  try {
    const states = await rows(
      knex,
      `select org_id, grain, region_id, watermark_ts, backfill_complete from rollup_state`,
    );
    if (states.length === 0) {
      console.log("No rollup state at all. The scheduler has never run; nothing to verify.");
      return;
    }
    for (const state of states) {
      console.log(
        `  state org=${state.org_id} grain=${state.grain} region=${state.region_id} ` +
          `watermark=${state.watermark_ts ? new Date(n(state.watermark_ts) * 1000).toISOString() : "none"} ` +
          `backfilled=${state.backfill_complete ? "yes" : "NO"}`,
      );
    }

    const orgIds = [...new Set(states.map((state) => n(state.org_id)))];

    for (const orgId of orgIds) {
      const hourWatermark = n(states.find((state) => n(state.org_id) === orgId && state.grain === "1h")?.watermark_ts);
      if (!hourWatermark) {
        console.log(`  org ${orgId}: no hourly watermark yet, skipping`);
        continue;
      }

      // Only days that are fully behind the watermark. A day still being written
      // is *supposed* to disagree with a rollup that has not caught up, and
      // flagging that would make the verifier cry wolf every run.
      const sealedBefore = Math.floor(hourWatermark / DAY) * DAY;
      const from = sealedBefore - windowDays * DAY;

      const candidates = await rows(
        knex,
        `SELECT monitor_tag, ${floorExpr('"timestamp" / ' + DAY)} * ${DAY} AS day_start
           FROM monitoring_data
          WHERE org_id = ? AND region_id = 0 AND "timestamp" >= ? AND "timestamp" < ?
          GROUP BY monitor_tag, ${floorExpr('"timestamp" / ' + DAY)} * ${DAY}`,
        [orgId, from, sealedBefore],
      );

      if (candidates.length === 0) {
        console.log(`  org ${orgId}: no sealed days with samples in the last ${windowDays} days`);
        continue;
      }

      const picked = candidates.sort(() => Math.random() - 0.5).slice(0, sampleCount);
      console.log(`\n  org ${orgId}: checking ${picked.length} of ${candidates.length} (monitor, day) pairs`);

      for (const candidate of picked) {
        const tag = String(candidate.monitor_tag);
        const dayStart = n(candidate.day_start);
        const label = `${tag} ${new Date(dayStart * 1000).toISOString().slice(0, 10)}`;

        // ---- straight from the samples, in SQL ---------------------------
        const [truth] = await rows(
          knex,
          `SELECT
             COUNT(*) AS count_total,
             SUM(CASE WHEN status = 'UP' THEN 1 ELSE 0 END) AS count_up,
             SUM(CASE WHEN status = 'DOWN' THEN 1 ELSE 0 END) AS count_down,
             SUM(CASE WHEN status = 'DEGRADED' THEN 1 ELSE 0 END) AS count_degraded,
             SUM(CASE WHEN status = 'MAINTENANCE' THEN 1 ELSE 0 END) AS count_maintenance,
             SUM(CASE WHEN status = 'NO_DATA' THEN 1 ELSE 0 END) AS count_no_data,
             SUM(CASE WHEN type IN (${placeholders(overlayTypes)}) THEN 1 ELSE 0 END) AS count_overlay,
             SUM(CASE WHEN type IN (${placeholders(overlayTypes)}) THEN 0 ELSE 1 END) AS count_observed,
             SUM(CASE WHEN type IN (${placeholders(latencyTypes)}) AND latency IS NOT NULL THEN 1 ELSE 0 END) AS latency_count,
             MIN("timestamp") AS first_ts,
             MAX("timestamp") AS last_ts
           FROM monitoring_data
          WHERE org_id = ? AND region_id = 0 AND monitor_tag = ?
            AND "timestamp" >= ? AND "timestamp" < ?`,
          [...overlayTypes, ...overlayTypes, ...latencyTypes, orgId, tag, dayStart, dayStart + DAY],
        );

        const [rollup] = await rows(
          knex,
          `SELECT * FROM monitor_rollup_1d
            WHERE org_id = ? AND monitor_tag = ? AND region_id = 0 AND bucket_start = ?`,
          [orgId, tag, dayStart],
        );

        if (!rollup) {
          check(`${label}: a sealed day has a daily rollup`, false, { expected_total: n(truth.count_total) });
          continue;
        }

        for (const column of [
          "count_total",
          "count_up",
          "count_down",
          "count_degraded",
          "count_maintenance",
          "count_no_data",
          "count_overlay",
          "count_observed",
          "latency_count",
        ]) {
          check(`${label}: ${column}`, n(rollup[column]) === n(truth[column]), {
            rollup: n(rollup[column]),
            raw: n(truth[column]),
          });
        }
        check(`${label}: first_ts`, n(rollup.first_ts) === n(truth.first_ts), {
          rollup: n(rollup.first_ts),
          raw: n(truth.first_ts),
        });
        check(`${label}: last_ts`, n(rollup.last_ts) === n(truth.last_ts), {
          rollup: n(rollup.last_ts),
          raw: n(truth.last_ts),
        });

        // ---- the grains against each other -------------------------------
        //
        // **Every grain finer than the day, derived rather than listed.** This
        // block used to name `1h` and `5m`, so when KENER-124 inserted `15m`
        // between them the new grain was the one thing the acceptance test never
        // looked at - and it was also the one grain that turned out to be empty
        // on an upgraded instance. A verifier that has to be remembered is a
        // verifier that goes quiet exactly when a grain is new.
        for (const grain of subDayGrains) {
          const [sums] = await rows(
            knex,
            `SELECT COUNT(*) AS buckets, SUM(count_total) AS count_total, SUM(count_up) AS count_up,
                    SUM(latency_count) AS latency_count
               FROM ${ROLLUP_TABLES[grain]}
              WHERE org_id = ? AND monitor_tag = ? AND region_id = 0
                AND bucket_start >= ? AND bucket_start < ?`,
            [orgId, tag, dayStart, dayStart + DAY],
          );

          // A grain with no buckets at all for a day the day-grain covers is the
          // upgrade failure itself, not a rounding difference, so it is worth
          // its own assertion rather than showing up as a count mismatch.
          check(`${label}: the ${grain} grain covers a sealed day`, n(sums.buckets) > 0, {
            buckets: n(sums.buckets),
            day_total: n(rollup.count_total),
          });

          for (const column of ["count_total", "count_up", "latency_count"]) {
            check(
              `${label}: the day equals the sum of its ${grain} buckets (${column})`,
              n(sums[column]) === n(rollup[column]),
              { day: n(rollup[column]), [grain]: n(sums[column]), buckets: n(sums.buckets) },
            );
          }
        }

        // A histogram is only absent when nothing had a latency worth recording.
        check(
          `${label}: a latency count implies a histogram`,
          n(rollup.latency_count) === 0 || !!rollup.latency_histogram,
          { latency_count: n(rollup.latency_count), histogram: rollup.latency_histogram },
        );
        check(`${label}: a latency count implies a p95`, n(rollup.latency_count) === 0 || rollup.latency_p95 !== null, {
          latency_count: n(rollup.latency_count),
          p95: rollup.latency_p95,
        });
      }
    }

    // Nothing should be sitting dirty for long; a growing set means the drain is
    // not keeping up, which is the failure that shows as stale bars.
    const [dirty] = await rows(knex, `select count(*) as c from rollup_dirty`);
    console.log(`\n  ${n(dirty.c)} hour(s) currently marked dirty`);

    console.log(
      `\n${failures === 0 ? `ALL PASS (${checks} assertions)` : `${failures} FAILURE(S) of ${checks} assertions`}\n`,
    );
  } finally {
    await knex.destroy();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
