import { describe, it, expect, beforeEach, vi } from "vitest";

import type { MonitorRollupInput, RollupGrain } from "../types/db.js";
import type { RollupState } from "../db/repositories/rollups.js";

/**
 * The backfill's upgrade path: a grain that did not exist when history was built.
 *
 * **This is the case that shipped broken.** `backfillChunk` asked `1h` whether
 * the region was done and returned immediately when it was, which is correct for
 * every grain built in the same pass and wrong for one added afterwards. On an
 * instance that had already finished, `15m` therefore kept
 * `backfill_complete = false` for ever while `setWatermark` handed it a
 * watermark - so `rollupsUsable("15m")` said no, and a viewer at +05:30 or
 * +05:45, the only viewers `pickGrain` sends to that grain, fell all the way back
 * to raw SQL. Adding the grain made exactly the people it was for slower.
 *
 * Nothing caught it because the fresh-database path is perfect: build a new
 * instance, every grain is written by the same pass and flagged together. The
 * hole is only reachable by completing a backfill and *then* introducing a
 * grain, which is what these tests do.
 */

const DAY = 86400;
const HOUR = 3600;

interface StateKey {
  grain: RollupGrain;
  region_id: number;
}

/**
 * A database that holds rollup rows and state, and nothing else.
 *
 * Real arithmetic on fake storage. The fold under test is exact - every coarse
 * bucket is the sum of the fine ones - so a test that stubbed the folding would
 * only be checking that the engine called a function. These tests keep the real
 * `foldRollups` and fake only the rows it reads.
 */
class FakeRollupDb {
  states = new Map<string, RollupState>();
  rows = new Map<RollupGrain, MonitorRollupInput[]>();
  rawBounds: { lo: number; hi: number } | null = null;

  private stateKey(grain: RollupGrain, regionId: number): string {
    return `${grain}:${regionId}`;
  }

  seedState(key: StateKey, patch: Partial<RollupState>): void {
    this.states.set(this.stateKey(key.grain, key.region_id), {
      grain: key.grain,
      region_id: key.region_id,
      watermark_ts: null,
      backfill_complete: false,
      backfill_cursor_ts: null,
      backfill_started_at: null,
      backfill_completed_at: null,
      ...patch,
    } as RollupState);
  }

  seedRows(grain: RollupGrain, rows: MonitorRollupInput[]): void {
    this.rows.set(grain, [...(this.rows.get(grain) ?? []), ...rows]);
  }

  // ---- the surface `rollupEngine` actually uses -------------------------

  async getAllRollupStates(): Promise<RollupState[]> {
    return [...this.states.values()];
  }

  async getRollupState(grain: RollupGrain, regionId: number): Promise<RollupState | undefined> {
    return this.states.get(this.stateKey(grain, regionId));
  }

  async upsertRollupState(
    grain: RollupGrain,
    regionId: number,
    patch: Partial<RollupState>,
    _nowTs: number,
  ): Promise<void> {
    const existing = this.states.get(this.stateKey(grain, regionId));
    if (existing) {
      this.states.set(this.stateKey(grain, regionId), { ...existing, ...patch });
      return;
    }
    this.seedState({ grain, region_id: regionId }, patch);
  }

  async getRollupBounds(grain: RollupGrain, regionId: number): Promise<{ lo: number; hi: number } | null> {
    const rows = (this.rows.get(grain) ?? []).filter((row) => row.region_id === regionId);
    if (rows.length === 0) return null;
    const starts = rows.map((row) => row.bucket_start);
    return { lo: Math.min(...starts), hi: Math.max(...starts) };
  }

  async getTagsWithRollups(grain: RollupGrain, regionId: number, from: number, to: number): Promise<string[]> {
    const tags = (this.rows.get(grain) ?? [])
      .filter((row) => row.region_id === regionId && row.bucket_start >= from && row.bucket_start < to)
      .map((row) => row.monitor_tag);
    return [...new Set(tags)];
  }

  async getRollups(
    grain: RollupGrain,
    monitorTags: ReadonlyArray<string>,
    regionId: number,
    from: number,
    to: number,
  ): Promise<MonitorRollupInput[]> {
    return (this.rows.get(grain) ?? [])
      .filter(
        (row) =>
          monitorTags.includes(row.monitor_tag) &&
          row.region_id === regionId &&
          row.bucket_start >= from &&
          row.bucket_start < to,
      )
      .sort((a, b) => a.bucket_start - b.bucket_start);
  }

  async deleteRollups(
    grain: RollupGrain,
    monitorTag: string,
    regionId: number | null,
    from: number | null,
    to: number | null,
  ): Promise<number> {
    const before = this.rows.get(grain) ?? [];
    const kept = before.filter(
      (row) =>
        !(
          row.monitor_tag === monitorTag &&
          (regionId === null || row.region_id === regionId) &&
          (from === null || row.bucket_start >= from) &&
          (to === null || row.bucket_start < to)
        ),
    );
    this.rows.set(grain, kept);
    return before.length - kept.length;
  }

  async upsertRollups(grain: RollupGrain, rows: ReadonlyArray<MonitorRollupInput>): Promise<number> {
    this.rows.set(grain, [...(this.rows.get(grain) ?? []), ...rows]);
    return rows.length;
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return await fn();
  }

  async getRawSampleBounds(): Promise<{ lo: number; hi: number } | null> {
    return this.rawBounds;
  }

  async getRawSamples(): Promise<[]> {
    return [];
  }

  async getTagsWithSamples(): Promise<string[]> {
    return [];
  }

  async getMaintenanceWindows(): Promise<Map<string, never[]>> {
    return new Map();
  }
}

const fake = new FakeRollupDb();

vi.mock("../db/db.js", () => ({
  default: {
    getAllRollupStates: () => fake.getAllRollupStates(),
    getRollupState: (...a: [RollupGrain, number]) => fake.getRollupState(...a),
    upsertRollupState: (...a: [RollupGrain, number, Partial<RollupState>, number]) => fake.upsertRollupState(...a),
    getRollupBounds: (...a: [RollupGrain, number]) => fake.getRollupBounds(...a),
    getTagsWithRollups: (...a: [RollupGrain, number, number, number]) => fake.getTagsWithRollups(...a),
    getRollups: (...a: [RollupGrain, string[], number, number, number]) => fake.getRollups(...a),
    deleteRollups: (...a: [RollupGrain, string, number | null, number | null, number | null]) =>
      fake.deleteRollups(...a),
    upsertRollups: (...a: [RollupGrain, MonitorRollupInput[]]) => fake.upsertRollups(...a),
    withTransaction: (fn: () => Promise<unknown>) => fake.withTransaction(fn),
    getRawSampleBounds: () => fake.getRawSampleBounds(),
    getRawSamplesForRollup: () => fake.getRawSamples(),
    getTagsWithSamples: () => fake.getTagsWithSamples(),
    getMaintenanceWindowsForRollup: () => fake.getMaintenanceWindows(),
  },
}));

const { backfillChunk, catchUpFoldedGrain, getRegionBackfillStatus } = await import("./rollupEngine.js");
const { FOLD_SOURCE, accumulatorToRow, aggregateSamples, foldRollups, grainSeconds, grainsInFoldOrder } =
  await import("./rollupCompute.js");

/** Five-minute rows for one monitor, built the way the raw pass builds them. */
function fiveMinuteRows(tag: string, regionId: number, from: number, to: number): MonitorRollupInput[] {
  const samples = [];
  for (let ts = from; ts < to; ts += 60) {
    samples.push({
      monitor_tag: tag,
      timestamp: ts,
      // A repeating pattern rather than all UP, so a fold that dropped or
      // double-counted a bucket changes the totals instead of hiding in them.
      status: ts % 900 === 0 ? "DOWN" : "UP",
      type: "REALTIME",
      latency: 100 + (ts % 7) * 10,
    });
  }
  const buckets = aggregateSamples(samples, grainSeconds("5m"), []);
  return [...buckets.entries()].map(([bucketStart, accumulator]) =>
    accumulatorToRow(accumulator, { monitor_tag: tag, region_id: regionId, bucket_start: bucketStart }, 0),
  );
}

const REGION = 0;
const START = 100 * DAY;
const SPAN = 3 * DAY;
const WATERMARK = START + SPAN;

/** An instance that finished its backfill before `15m` existed. */
function seedUpgradedInstance(): void {
  for (const grain of ["5m", "1h", "1d"] as RollupGrain[]) {
    fake.seedState(
      { grain, region_id: REGION },
      { watermark_ts: WATERMARK, backfill_complete: true, backfill_cursor_ts: WATERMARK },
    );
  }
  // What the migration plus the forward pass leave behind: a watermark, because
  // `setWatermark` writes every grain, and no completion, because nothing built
  // the history.
  fake.seedState({ grain: "15m", region_id: REGION }, { watermark_ts: WATERMARK, backfill_complete: false });
  fake.seedRows("5m", fiveMinuteRows("earth", REGION, START, START + SPAN));
  fake.seedRows("5m", fiveMinuteRows("mars", REGION, START, START + SPAN));
}

/** Drives the scheduler's one-chunk-per-tick loop to completion. */
async function runBackfillToCompletion(maxTicks = 50): Promise<number> {
  for (let tick = 0; tick < maxTicks; tick++) {
    const progress = await backfillChunk(REGION, WATERMARK + HOUR, 1);
    const status = await getRegionBackfillStatus(REGION);
    if (status.complete) return tick + 1;
    if (progress.chunksProcessed === 0 && !progress.done) {
      throw new Error(`backfill made no progress on tick ${tick}`);
    }
  }
  throw new Error("backfill did not complete");
}

beforeEach(() => {
  fake.states.clear();
  fake.rows.clear();
  fake.rawBounds = null;
});

describe("grainsInFoldOrder", () => {
  it("puts every grain after the grain it folds from", () => {
    const ordered = grainsInFoldOrder();
    expect(new Set(ordered)).toEqual(new Set(Object.keys(FOLD_SOURCE)));
    for (const [index, grain] of ordered.entries()) {
      const source = FOLD_SOURCE[grain];
      if (source === null) continue;
      expect(ordered.indexOf(source)).toBeLessThan(index);
    }
  });

  it("starts from a grain that reads raw samples", () => {
    // Something has to touch the samples. A chain where every grain folds from
    // another is a chain nothing can start, and it would deadlock the backfill
    // rather than fail it.
    expect(FOLD_SOURCE[grainsInFoldOrder()[0]]).toBeNull();
  });
});

describe("a grain added after the backfill already completed", () => {
  it("is not reported complete just because the hourly grain is", async () => {
    seedUpgradedInstance();
    const status = await getRegionBackfillStatus(REGION);
    expect(status.complete).toBe(false);
  });

  it("gets built, and becomes usable", async () => {
    seedUpgradedInstance();
    await runBackfillToCompletion();

    const state = await fake.getRollupState("15m", REGION);
    expect(state?.backfill_complete).toBe(true);
    expect(state?.watermark_ts).not.toBeNull();

    // The two conditions `rollupsUsable` checks, which is what the read path
    // consults before it will serve this grain at all.
    expect(!!state?.backfill_complete && state?.watermark_ts !== null).toBe(true);
  });

  it("builds buckets that are the exact fold of the grain below", async () => {
    seedUpgradedInstance();
    await runBackfillToCompletion();

    for (const tag of ["earth", "mars"]) {
      const source = await fake.getRollups("5m", [tag], REGION, START, WATERMARK);
      const expected = foldRollups(source, grainSeconds("15m"));
      const actual = await fake.getRollups("15m", [tag], REGION, START, WATERMARK);

      expect(actual.length).toBe(expected.size);
      for (const row of actual) {
        const want = expected.get(row.bucket_start);
        expect(want, `no expected bucket at ${row.bucket_start}`).toBeDefined();
        expect(row.count_total).toBe(want!.count_total);
        expect(row.count_up).toBe(want!.count_up);
        expect(row.count_down).toBe(want!.count_down);
        expect(row.latency_sum).toBe(want!.latency_sum);
        expect(row.latency_count).toBe(want!.latency_count);
        expect(row.latency_min).toBe(want!.latency_min);
        expect(row.latency_max).toBe(want!.latency_max);
      }
    }
  });

  it("conserves the totals of the grain it folded from", async () => {
    seedUpgradedInstance();
    await runBackfillToCompletion();

    const sum = async (grain: RollupGrain) =>
      (await fake.getRollups(grain, ["earth", "mars"], REGION, START, WATERMARK)).reduce(
        (total, row) => total + row.count_total,
        0,
      );

    // Every sample below the watermark has to appear in the new grain exactly
    // once. A fold that skipped a chunk boundary loses some; one that overlapped
    // counts them twice, and both look like a plausible uptime figure.
    expect(await sum("15m")).toBe(await sum("5m"));
    expect(await sum("15m")).toBeGreaterThan(0);
  });

  it("does not write buckets past the watermark", async () => {
    seedUpgradedInstance();
    // Sealed rows the forward pass has not reached, which the fold must leave
    // alone: they are above the watermark and still being rewritten.
    fake.seedRows("5m", fiveMinuteRows("earth", REGION, WATERMARK, WATERMARK + 2 * HOUR));
    await runBackfillToCompletion();

    const beyond = (await fake.getRollups("15m", ["earth"], REGION, WATERMARK, WATERMARK + DAY)).length;
    expect(beyond).toBe(0);
  });

  it("leaves the grains that were already built alone", async () => {
    seedUpgradedInstance();
    const before = (await fake.getRollupState("1h", REGION))?.backfill_completed_at ?? null;
    await runBackfillToCompletion();

    expect((await fake.getRollupState("1h", REGION))?.backfill_complete).toBe(true);
    expect((await fake.getRollupState("1h", REGION))?.backfill_completed_at).toBe(before);
    // The fold reads `5m` and writes `15m`. Touching the source would mean the
    // catch-up could corrupt history that was already correct.
    expect((await fake.getRollups("5m", ["earth"], REGION, START, WATERMARK)).length).toBeGreaterThan(0);
  });

  it("resumes from its cursor instead of starting again", async () => {
    seedUpgradedInstance();
    await backfillChunk(REGION, WATERMARK + HOUR, 1);
    const afterFirst = (await fake.getRollupState("15m", REGION))?.backfill_cursor_ts ?? null;
    expect(afterFirst).not.toBeNull();
    expect(afterFirst).toBeGreaterThan(START);

    await backfillChunk(REGION, WATERMARK + HOUR, 1);
    const afterSecond = (await fake.getRollupState("15m", REGION))?.backfill_cursor_ts ?? null;
    expect(afterSecond).toBeGreaterThanOrEqual(afterFirst!);
  });

  it("stops doing work once every grain is complete", async () => {
    seedUpgradedInstance();
    await runBackfillToCompletion();

    const progress = await backfillChunk(REGION, WATERMARK + HOUR, 1);
    expect(progress.done).toBe(true);
    expect(progress.chunksProcessed).toBe(0);
  });
});

describe("catchUpFoldedGrain", () => {
  it("refuses a grain that reads raw samples", async () => {
    // `5m` has no source to fold from, so asking for it is a programming error
    // rather than a no-op. Returning done would flag it complete without
    // building anything.
    await expect(catchUpFoldedGrain("5m", REGION, WATERMARK, 1)).rejects.toThrow(/raw samples/);
  });

  it("waits for a watermark rather than completing on an empty region", async () => {
    fake.seedState({ grain: "15m", region_id: REGION }, { watermark_ts: null, backfill_complete: false });
    const progress = await catchUpFoldedGrain("15m", REGION, WATERMARK, 1);

    // No watermark means the forward pass has not run, so there is no sealed
    // boundary to fold up to. Completing here would flag a grain that holds
    // nothing, and the read path would then trust it.
    expect(progress.done).toBe(false);
    expect((await fake.getRollupState("15m", REGION))?.backfill_complete).toBe(false);
  });

  it("completes immediately when the source grain holds nothing", async () => {
    fake.seedState({ grain: "15m", region_id: REGION }, { watermark_ts: WATERMARK, backfill_complete: false });
    const progress = await catchUpFoldedGrain("15m", REGION, WATERMARK, 1);

    // Nothing to fold is not the same as not finished. Leaving it false would
    // hold the read path on raw SQL for ever over an empty source.
    expect(progress.done).toBe(true);
    expect((await fake.getRollupState("15m", REGION))?.backfill_complete).toBe(true);
  });
});
