/**
 * A mergeable latency histogram (F6a).
 *
 * **Mergeability is the entire requirement, and it is why this exists at all.**
 * You cannot average percentiles. A 90-day bar spans ninety daily rollups and a
 * report spans thousands of five-minute ones, so the stored form has to be
 * something that combines exactly - and a histogram does, by element-wise
 * integer addition, in plain JavaScript, with no dependency.
 *
 * **Why not `percentile_cont`.** Postgres computes percentiles over *raw rows*,
 * which is precisely the scan the rollups exist to eliminate, and it can compute
 * nothing at all once retention has deleted those rows. The percentile has to
 * survive in the rollup or it does not survive.
 *
 * **Why not t-digest.** t-digest buys accuracy in the far tail. At one external
 * HTTP probe per minute the far tail is a handful of samples whose latency is
 * dominated by network noise, so that accuracy measures nothing real - and it
 * costs a dependency and an opaque binary blob in a column a human might want to
 * read. A log histogram's error is bounded and legible instead.
 *
 * **The shape.** 64 buckets, base 1ms, each 1.2x the last. Bucket `i` covers
 * `[1.2^i, 1.2^(i+1))`, so the set spans 1ms to about 99 seconds and any answer
 * is within the width of one bucket - at most 20%, and typically nearer 5% once
 * the position within the bucket is interpolated. That is well inside the
 * run-to-run variance of the thing being measured.
 *
 * **Saturation is real and deliberate.** A latency above `HISTOGRAM_MAX_MS`
 * lands in the top bucket and reads back as at most that value. A check that
 * takes 99 seconds has already blown through every timeout Kener offers, so the
 * distinction between 99s and 200s is not one any report needs to draw.
 */

export const HISTOGRAM_BUCKETS = 64;
export const HISTOGRAM_BASE_MS = 1;
export const HISTOGRAM_GROWTH = 1.2;

const LN_GROWTH = Math.log(HISTOGRAM_GROWTH);

/** The top of the highest bucket. Anything above this reads back as this. */
export const HISTOGRAM_MAX_MS = HISTOGRAM_BASE_MS * Math.pow(HISTOGRAM_GROWTH, HISTOGRAM_BUCKETS);

/**
 * Bucket index to count. Sparse: a bucket with no samples is absent, not zero.
 *
 * A `Map` rather than an object because merging is the hot operation and this is
 * the shape that merges without a key-type round trip through strings.
 */
export type LatencyHistogram = Map<number, number>;

export function emptyHistogram(): LatencyHistogram {
  return new Map();
}

/**
 * The bucket a latency falls in.
 *
 * Everything at or below 0 goes to bucket 0 rather than being rejected: a DOWN
 * sample can legitimately record 0ms, and it is the caller's job to decide
 * whether such a sample belongs in the distribution at all. This function
 * records what it is given.
 */
export function bucketIndexFor(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs <= HISTOGRAM_BASE_MS) return 0;
  const index = Math.floor(Math.log(latencyMs / HISTOGRAM_BASE_MS) / LN_GROWTH);
  if (index < 0) return 0;
  return index >= HISTOGRAM_BUCKETS ? HISTOGRAM_BUCKETS - 1 : index;
}

/**
 * The half-open range a bucket covers.
 *
 * Bucket 0 starts at 0, not at 1ms, because it also absorbs everything below the
 * base - interpolating over `[1, 1.2)` for a bucket that actually holds 0ms
 * samples would report a latency the monitor never saw.
 */
export function bucketBounds(index: number): { lo: number; hi: number } {
  const lo = index === 0 ? 0 : HISTOGRAM_BASE_MS * Math.pow(HISTOGRAM_GROWTH, index);
  const hi = HISTOGRAM_BASE_MS * Math.pow(HISTOGRAM_GROWTH, index + 1);
  return { lo, hi };
}

/** Adds `count` observations of `latencyMs`, in place. */
export function recordLatency(histogram: LatencyHistogram, latencyMs: number, count = 1): void {
  if (count <= 0) return;
  const index = bucketIndexFor(latencyMs);
  histogram.set(index, (histogram.get(index) ?? 0) + count);
}

export function histogramFromLatencies(values: Iterable<number>): LatencyHistogram {
  const histogram = emptyHistogram();
  for (const value of values) recordLatency(histogram, value);
  return histogram;
}

/**
 * Combines any number of histograms into a new one.
 *
 * This is the whole point of the design: folding twelve five-minute buckets into
 * an hour, or ninety days into a bar, is this function and nothing else. It is
 * exact - no approximation is introduced by merging, only by bucketing, and that
 * happened once when the sample was recorded.
 */
export function mergeHistograms(...histograms: Array<LatencyHistogram | null | undefined>): LatencyHistogram {
  const merged = emptyHistogram();
  for (const histogram of histograms) {
    if (!histogram) continue;
    for (const [index, count] of histogram) {
      merged.set(index, (merged.get(index) ?? 0) + count);
    }
  }
  return merged;
}

export function histogramCount(histogram: LatencyHistogram): number {
  let total = 0;
  for (const count of histogram.values()) total += count;
  return total;
}

/**
 * The `q`-th quantile, in milliseconds, or null when there are no samples.
 *
 * Interpolates linearly within the bucket that contains the rank, which keeps
 * the answer inside that bucket's range - so the error can never exceed the
 * bucket's width however the samples are distributed inside it.
 */
export function histogramQuantile(histogram: LatencyHistogram, q: number): number | null {
  const total = histogramCount(histogram);
  if (total === 0) return null;

  const clamped = q < 0 ? 0 : q > 1 ? 1 : q;
  const rank = clamped * total;

  const indexes = [...histogram.keys()].sort((a, b) => a - b);
  let cumulative = 0;
  for (const index of indexes) {
    const count = histogram.get(index) ?? 0;
    if (cumulative + count >= rank) {
      const { lo, hi } = bucketBounds(index);
      // Where in this bucket the rank falls, in (0, 1]. `count` is at least 1
      // here because a zero-count bucket is never stored.
      const position = count === 0 ? 1 : (rank - cumulative) / count;
      return lo + (hi - lo) * Math.min(1, Math.max(0, position));
    }
    cumulative += count;
  }

  // Floating-point drift in the accumulation can leave the loop one hair short
  // of the rank on the last bucket. The answer is the top of the highest
  // occupied bucket.
  const { hi } = bucketBounds(indexes[indexes.length - 1]);
  return hi;
}

export interface LatencyPercentiles {
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
}

/** The four percentiles the rollup tables materialize as columns. */
export function histogramPercentiles(histogram: LatencyHistogram): LatencyPercentiles {
  return {
    p50: histogramQuantile(histogram, 0.5),
    p90: histogramQuantile(histogram, 0.9),
    p95: histogramQuantile(histogram, 0.95),
    p99: histogramQuantile(histogram, 0.99),
  };
}

/**
 * The stored form: a sparse JSON object of bucket index to count, or null when
 * there is nothing to store.
 *
 * **Keys are emitted in ascending numeric order**, which makes the encoding
 * deterministic. Two rollups computed from the same samples then produce byte-
 * identical text, so a recompute can be compared against what is already stored
 * instead of only against a decoded interpretation of it.
 *
 * Null rather than `"{}"` for an empty histogram: the column means "no latency
 * was recorded in this bucket", and a null says that in a way a `COUNT` and a
 * human both understand.
 */
export function encodeHistogram(histogram: LatencyHistogram): string | null {
  if (histogram.size === 0) return null;
  const ordered: Record<string, number> = {};
  for (const index of [...histogram.keys()].sort((a, b) => a - b)) {
    ordered[String(index)] = histogram.get(index) ?? 0;
  }
  return JSON.stringify(ordered);
}

/**
 * Reads the stored form back.
 *
 * Tolerant on purpose: a column that is null, empty, unparseable or holds
 * something other than an object of numbers comes back as an empty histogram
 * rather than throwing. This is read on the page-render path, and a rollup row
 * corrupted by something upstream should cost a latency number, not the page.
 * Out-of-range indexes and non-positive counts are dropped for the same reason.
 */
export function decodeHistogram(encoded: string | null | undefined): LatencyHistogram {
  const histogram = emptyHistogram();
  if (!encoded) return histogram;

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return histogram;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return histogram;

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const index = Number(key);
    const count = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= HISTOGRAM_BUCKETS) continue;
    if (!Number.isFinite(count) || count <= 0) continue;
    histogram.set(index, (histogram.get(index) ?? 0) + count);
  }
  return histogram;
}
