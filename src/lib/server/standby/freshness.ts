import type { Knex } from "knex";
import { IsStandby, StandbyStaleSeconds } from "./config.js";

export const STANDBY_STATE_TABLE = "standby_state";
export const STANDBY_STATE_ID = 1;

export interface StandbyStateRow {
  id: number;
  last_pull_at: number | null;
  data_at: number | null;
  schema_version: string | null;
  images_fingerprint: string | null;
  last_attempt_at: number | null;
  last_error: string | null;
}

export interface StandbyFreshness {
  /** Standby clock, when the last good pull finished. Null until the first one. */
  lastPullAt: number | null;
  /** Primary clock, when the data the standby holds was read. */
  dataAt: number | null;
  /** Seconds since the last good pull, null when there has been none. */
  ageSeconds: number | null;
  staleAfterSeconds: number;
  /** No good pull yet, or the last one is older than the threshold. */
  stale: boolean;
  lastAttemptAt: number | null;
  lastError: string | null;
}

export function ComputeStandbyFreshness(
  state: Pick<StandbyStateRow, "last_pull_at" | "data_at" | "last_attempt_at" | "last_error"> | null | undefined,
  nowSeconds: number,
  staleAfterSeconds: number,
): StandbyFreshness {
  const lastPullAt = toSeconds(state?.last_pull_at);
  const ageSeconds = lastPullAt === null ? null : Math.max(0, nowSeconds - lastPullAt);
  return {
    lastPullAt,
    dataAt: toSeconds(state?.data_at),
    ageSeconds,
    staleAfterSeconds,
    stale: ageSeconds === null || ageSeconds > staleAfterSeconds,
    lastAttemptAt: toSeconds(state?.last_attempt_at),
    lastError: state?.last_error ?? null,
  };
}

function toSeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Read on every status lookup, so held briefly rather than queried per monitor.
const MEMO_MS = 5000;
let memo: { at: number; value: StandbyFreshness } | null = null;

export function ResetStandbyFreshnessMemo(): void {
  memo = null;
}

/** Null on a primary, without touching the database. */
export async function ReadStandbyFreshness(knex: Knex, nowMs: number = Date.now()): Promise<StandbyFreshness | null> {
  if (!IsStandby()) return null;
  if (memo && nowMs - memo.at < MEMO_MS) return memo.value;
  let state: StandbyStateRow | undefined;
  try {
    state = await knex(STANDBY_STATE_TABLE).where("id", STANDBY_STATE_ID).first();
  } catch (error) {
    // Unreadable bookkeeping is no proof the data is current.
    console.error("Standby: could not read standby_state:", error);
    state = undefined;
  }
  const value = ComputeStandbyFreshness(state, Math.floor(nowMs / 1000), StandbyStaleSeconds());
  memo = { at: nowMs, value };
  return value;
}

/** True only on a standby whose data is too old to state a current status. */
export async function StandbyDataIsStale(knex: Knex): Promise<boolean> {
  return (await ReadStandbyFreshness(knex))?.stale === true;
}
