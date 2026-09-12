import { Cron } from "croner";

/**
 * B11. Schedule-aware evaluation for HEARTBEAT monitors.
 *
 * A fixed timeout cannot express "this job runs at 02:00 daily". With a timeout
 * only, a nightly job looks healthy all morning and unhealthy at 27 hours, so
 * you can neither alert promptly at 02:15 nor tell "ran late" from "did not run
 * at all". An expected cron plus a grace period gives both.
 */

/** How many past occurrences we are willing to look at when counting misses. */
const MAX_OCCURRENCES = 12;

/** Hard cap on the forward walk, so a pathological pattern cannot spin. */
const MAX_WALK_STEPS = 2000;

/** Used when two future runs do not yield a usable period. */
const FALLBACK_PERIOD_MS = 24 * 60 * 60 * 1000;

export type ScheduleState =
  | "ON_TIME" /** The job ran for the window that is currently open. */
  | "IN_GRACE" /** The window is open and grace has not run out yet. */
  | "LATE" /** Grace ran out on one window; earlier windows were met. */
  | "MISSING" /** Two or more consecutive windows went unmet. */
  | "INVALID"; /** The pattern did not parse. */

export interface ScheduleEvaluation {
  state: ScheduleState;
  /** The occurrence being judged, UTC seconds, or null if none has come due. */
  expectedAt: number | null;
  /** When grace ran out on `expectedAt`, UTC seconds. */
  dueAt: number | null;
  /** Consecutive expected runs with no heartbeat. Capped at MAX_OCCURRENCES. */
  missedWindows: number;
  /** Why the pattern was rejected. Only set when state is INVALID. */
  reason?: string;
}

/**
 * The occurrences of `cron` at or before `nowMs`, most recent first.
 *
 * croner's own `previousRun()` takes no argument and reports when that Cron
 * instance last *fired*, not what the pattern would have produced, so it cannot
 * answer this. We bracket the search instead: two future runs give the
 * pattern's period, we step back a few periods and walk `nextRun` forward.
 *
 * Irregular patterns are the reason for the retry. A weekday pattern looks like
 * a one-day period on a Tuesday but has a three-day gap across the weekend, so
 * a lookback sized from the period alone can come up short. When the walk finds
 * fewer than asked for, the window widens and we try again.
 */
export function occurrencesAtOrBefore(cron: Cron, nowMs: number, count: number): number[] {
  const now = new Date(nowMs);

  const first = cron.nextRun(now);
  if (!first) return [];
  const second = cron.nextRun(first);

  const measured = second ? second.getTime() - first.getTime() : 0;
  const period = measured > 0 ? measured : FALLBACK_PERIOD_MS;

  let span = period * (count + 3);

  for (let attempt = 0; attempt < 4; attempt++) {
    const found: number[] = [];
    let cursor = new Date(nowMs - span);
    let steps = 0;

    while (steps++ < MAX_WALK_STEPS) {
      const next = cron.nextRun(cursor);
      if (!next || next.getTime() > nowMs) break;
      found.push(next.getTime());
      cursor = next;
    }

    if (found.length >= count || steps >= MAX_WALK_STEPS) {
      return found.slice(-count).reverse();
    }
    span *= 4;
  }

  return [];
}

/**
 * Judge a heartbeat against its expected schedule.
 *
 * `lastSec` is when the job last checked in, or null if it never has. Callers
 * handle the never-checked-in case themselves, because an unmet schedule and a
 * monitor that has simply not been wired up yet deserve different statuses.
 */
export function evaluateSchedule(args: {
  pattern: string;
  timezone: string;
  graceSeconds: number;
  nowSec: number;
  lastSec: number | null;
}): ScheduleEvaluation {
  const { pattern, timezone, graceSeconds, nowSec, lastSec } = args;

  let cron: Cron;
  try {
    cron = new Cron(pattern, { timezone });
    // croner accepts the pattern lazily, so force it to produce a date here.
    if (!cron.nextRun(new Date(nowSec * 1000))) {
      return { state: "INVALID", expectedAt: null, dueAt: null, missedWindows: 0, reason: "the pattern never fires" };
    }
  } catch (error: unknown) {
    return {
      state: "INVALID",
      expectedAt: null,
      dueAt: null,
      missedWindows: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const occurrences = occurrencesAtOrBefore(cron, nowSec * 1000, MAX_OCCURRENCES).map((ms) => Math.floor(ms / 1000));

  // Nothing has come due yet, so there is nothing to have missed.
  if (occurrences.length === 0) {
    return { state: "ON_TIME", expectedAt: null, dueAt: null, missedWindows: 0 };
  }

  const expectedAt = occurrences[0];
  const dueAt = expectedAt + graceSeconds;

  if (lastSec !== null && lastSec >= expectedAt) {
    return { state: "ON_TIME", expectedAt, dueAt, missedWindows: 0 };
  }

  if (nowSec <= dueAt) {
    return { state: "IN_GRACE", expectedAt, dueAt, missedWindows: 0 };
  }

  // Grace has run out. Every occurrence newer than the last check-in is a
  // window the job owed us and did not deliver.
  const missedWindows = lastSec === null ? occurrences.length : occurrences.filter((o) => o > lastSec).length;

  return { state: missedWindows > 1 ? "MISSING" : "LATE", expectedAt, dueAt, missedWindows };
}
