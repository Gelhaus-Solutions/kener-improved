import db from "../db/db.js";
import GC from "../../global-constants.js";
import type { IncidentRecord } from "../types/db.js";

/**
 * C2c: MTTD, MTTA and MTTR, computed rather than stored.
 *
 * **Nothing here is precomputed and nothing is cached, and that is the item's
 * instruction rather than an omission.** At a few hundred incidents a year an
 * indexed scan over `incidents` answers every question a metrics screen asks -
 * counts by severity, counts by component, trends - in one query. A precomputed
 * table would be a second source of truth that drifts the first time somebody
 * corrects an incident's start time and forgets to recompute, and the drift is
 * invisible: a wrong MTTR looks exactly like a right one.
 *
 * The four durations, and what each is honestly measuring:
 *
 *   MTTD  detection lag. `detected_at` minus the moment the monitors first went
 *         non-UP. **This is the interesting one**, because it measures Kener's
 *         own blind spot rather than how fast a human reacted once paged. A
 *         five-minute confirmation threshold shows up here and nowhere else.
 *
 *   MTTA  `acknowledged_at` minus detection. How long until a human took it.
 *
 *   MTTR  `resolved_at` minus detection. The one people quote. Measured from
 *         detection rather than from the true start on purpose: an organisation
 *         cannot be held to a repair clock that started before it could possibly
 *         have known. The undetected part is MTTD's to report, and adding the two
 *         gives total customer-visible duration for anyone who wants it.
 *
 * Every one of them is null when its inputs are missing, and null is never
 * replaced by a plausible-looking substitute. An incident nobody acknowledged has
 * no MTTA; reporting zero would say somebody acknowledged it instantly.
 */

/**
 * How far back the true-start walk will look, in seconds.
 *
 * Twenty-four hours, which is 1440 one-minute samples per monitor. The walk stops
 * at the first UP sample, so this bound only binds for an outage that had already
 * been running for a day when it was detected - and for that one, "detection lag
 * was at least 24 hours" is a true and sufficient answer. Without a bound, a
 * monitor that has been down since it was created would scan its entire retained
 * history on every read of the metrics screen.
 */
export const TRUE_START_LOOKBACK_SECONDS = 24 * 60 * 60;

export interface IncidentDurations {
  /**
   * When the monitors first went non-UP, as far as the samples can say.
   *
   * Null when there is no evidence: no monitors attached, no observed samples in
   * the window, or the monitor was already non-UP at the far edge of the
   * lookback, in which case the true start is older than this can prove and
   * claiming the edge would understate the gap.
   */
  impact_started_at: number | null;
  /** Seconds between the true start and detection. */
  mttd: number | null;
  /** Seconds between detection and the first human acknowledgement. */
  mtta: number | null;
  /** Seconds between detection and resolution. */
  mttr: number | null;
  /** Seconds between detection and entering IDENTIFIED. */
  time_to_identify: number | null;
  /** Seconds between detection and entering MONITORING. */
  time_to_mitigate: number | null;
  /**
   * What the durations are measured from.
   *
   * `ALERT` when `detected_at` is set, meaning a monitor observed the problem.
   * `REPORTED` when it is not: a dashboard-created incident was never detected
   * by anything, so the clock starts at the start time an operator declared.
   * Surfaced rather than hidden because the two are not the same measurement and
   * a chart that averaged them without saying so would be quietly dishonest.
   */
  basis: "ALERT" | "REPORTED";
}

type IncidentForMetrics = Pick<
  IncidentRecord,
  "id" | "start_date_time" | "detected_at" | "acknowledged_at" | "identified_at" | "mitigated_at" | "resolved_at"
>;

/** Non-negative difference, or null when either end is missing. */
export function since(from: number | null, to: number | null | undefined): number | null {
  if (from === null || to === null || to === undefined) return null;
  const delta = to - from;
  // A negative duration means the two timestamps disagree - an operator moved
  // the start time to after the resolution, say. Reporting a negative MTTR would
  // put a nonsense point on every chart that averages it, and clamping to zero
  // would silently invent a plausible one. Null says "this pair cannot be
  // measured", which is what is actually true.
  return delta < 0 ? null : delta;
}

/**
 * The first non-UP observed minute of the outage this incident describes.
 *
 * Walks backwards from the anchor through the observed samples of every monitor
 * attached to the incident, stopping at the first UP. Across monitors it takes
 * the earliest, because an incident spanning three components started when the
 * first of them broke.
 *
 * **When P5 lands this is the one function that changes.** The rollups hold the
 * same minutes in a coarser grain, so the query moves there and the walk stays
 * identical; the number it returns does not move.
 */
export interface ObservedSample {
  monitor_tag: string;
  timestamp: number;
  status: string | null;
}

/**
 * The walk itself, over samples already fetched. Pure, so it can be tested
 * against series a database fixture would take a page to express.
 *
 * `samples` must be ordered newest first; that is what the query does and what
 * the walk depends on.
 */
export function firstNonUpMinute(samples: ObservedSample[]): number | null {
  if (samples.length === 0) return null;

  const byTag = new Map<string, ObservedSample[]>();
  for (const sample of samples) {
    const list = byTag.get(sample.monitor_tag);
    if (list) list.push(sample);
    else byTag.set(sample.monitor_tag, [sample]);
  }

  let earliest: number | null = null;
  for (const [, series] of byTag) {
    // The most recent sample has to be non-UP for there to be an outage running
    // at the anchor at all. A monitor that was healthy when the incident was
    // detected contributes nothing: it may have been added to the incident for
    // communication reasons, and letting it vote would date the outage from some
    // unrelated blip earlier in the window.
    if (series.length === 0 || series[0].status === GC.UP) continue;

    let start: number | null = null;
    let reachedEdge = true;
    for (const sample of series) {
      if (sample.status === GC.UP) {
        reachedEdge = false;
        break;
      }
      start = sample.timestamp;
    }

    // The walk ran out of samples without finding a healthy one, so the outage
    // began before anything this window can see. Claiming the oldest sample would
    // report a detection gap of exactly the lookback, every time, for a monitor
    // that has simply been down for days.
    if (reachedEdge) continue;
    if (start !== null && (earliest === null || start < earliest)) earliest = start;
  }

  return earliest;
}

export async function findTrueOutageStart(
  monitorTags: string[],
  anchor: number,
  lookbackSeconds: number = TRUE_START_LOOKBACK_SECONDS,
): Promise<number | null> {
  if (monitorTags.length === 0) return null;
  const samples = await db.getObservedSamplesInWindow(monitorTags, anchor - lookbackSeconds, anchor);
  return firstNonUpMinute(samples);
}

/**
 * Every duration for one incident.
 *
 * `monitorTags` is passed in rather than fetched here so a caller computing this
 * for a page of incidents can do one join instead of one query per row. Pass an
 * empty array and `impact_started_at` and MTTD come back null, which is the right
 * answer for an incident with no components attached.
 */
export async function computeIncidentDurations(
  incident: IncidentForMetrics,
  monitorTags: string[],
): Promise<IncidentDurations> {
  // `detected_at` is null for anything the dashboard or the API opened, which is
  // most incidents on most instances. Falling back to the declared start keeps
  // MTTA and MTTR computable for them; `basis` is what stops the two kinds being
  // averaged together without anyone noticing.
  const basis: "ALERT" | "REPORTED" = incident.detected_at !== null ? "ALERT" : "REPORTED";
  const anchor = incident.detected_at ?? incident.start_date_time;

  // Only a real detection has a detection lag to measure. For a reported
  // incident the anchor *is* the operator's account of when it started, so
  // subtracting one from the other would always give zero and would dilute every
  // MTTD average it landed in.
  const impactStartedAt = basis === "ALERT" ? await findTrueOutageStart(monitorTags, anchor) : null;

  return {
    impact_started_at: impactStartedAt,
    mttd: since(impactStartedAt, anchor),
    mtta: since(anchor, incident.acknowledged_at),
    mttr: since(anchor, incident.resolved_at),
    time_to_identify: since(anchor, incident.identified_at),
    time_to_mitigate: since(anchor, incident.mitigated_at),
    basis,
  };
}
