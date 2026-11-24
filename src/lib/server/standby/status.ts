import db from "../db/db.js";

/** Layout data for the stale banner; null whenever the page is current. */
export interface StandbyNotice {
  /** Primary clock: when the shown data was read. Null before the first pull. */
  dataAt: number | null;
}

export async function GetStandbyNotice(): Promise<StandbyNotice | null> {
  const freshness = await db.getStandbyFreshness();
  return freshness?.stale ? { dataAt: freshness.dataAt } : null;
}
