/**
 * B12b. One multi-region service's status, from its regional endpoints.
 *
 * **The rule is FIXED and nothing about it is configurable.** All regions up is
 * UP, some down is DEGRADED, all down is DOWN. No weights, no quorum, no policy
 * row, nothing on a screen. That is deliberate and it is the opposite of B1d's
 * probe merge cascade, which stays exactly where it is: the cascade answers
 * "several vantage points disagree about one thing, which do I believe", and
 * this answers "several different things are each independently up or down, how
 * healthy is the service they add up to". Disagreement is a question only in the
 * first one. Two regions reporting differently here is not a conflict to resolve;
 * it is the answer.
 *
 * Shared rather than server-only so the screen that explains the rule to an
 * operator reads it from the same place the scheduler applies it, the way
 * `mapModel.ts` is shared between the map's builder and the map.
 */

/** What one regional endpoint is currently reporting. */
export interface RegionSample {
  regionId: number;
  /**
   * `UP`, `DEGRADED`, `DOWN` or `MAINTENANCE`, or null for a region that has not
   * reported recently enough to be believed.
   *
   * Null is a first-class input, not an absence to be tidied away. See below.
   */
  status: string | null;
  latencyMs?: number | null;
}

export interface RegionRollup {
  /**
   * The service's status, or null when nothing could decide.
   *
   * **Null rather than UP, and never DOWN.** A monitor sample may only be UP,
   * DEGRADED or DOWN (`MONITORING_STATUSES`), so "we cannot see any of this
   * service's regions" has no sample to write and must write none at all.
   * `Service.execute` already returns null for exactly this, and
   * `monitorExecuteQueue` skips a null rather than inventing a row.
   */
  status: "UP" | "DEGRADED" | "DOWN" | "MAINTENANCE" | null;
  /** Regions that contributed to the verdict: up, degraded or down. */
  observed: number;
  /** Which regions are down, so an alert can name them (Enno's Q3 decision). */
  down: number[];
  degraded: number[];
  /** Recorded and excluded: under maintenance. */
  maintenance: number[];
  /** Recorded and excluded: not reporting. NOT the same thing as down. */
  silent: number[];
  /**
   * Average latency across the regions that are actually serving.
   *
   * Null when none are.
   */
  latencyMs: number | null;
}

/**
 * Applies the fixed rule.
 *
 * **Two exclusions, and getting either wrong makes this feature lie.**
 *
 *   - **A region that is not reporting is not a region that is down.** Silence
 *     means the endpoint has not been checked recently enough to be believed,
 *     and counting it as down announces an outage nobody observed. That is the
 *     exact shape of KENER-151, where an alert manufactured the downtime that
 *     kept its own burn rate high. Silent regions are recorded in `silent` and
 *     kept out of the tally.
 *   - **A region under maintenance is not down either**, and must not drag the
 *     service to DEGRADED - an operator who took one region out on purpose has
 *     not had an incident. Excluded from the tally too, and if maintenance is
 *     ALL that is left, the service is MAINTENANCE rather than unknown.
 *
 * **A service with one region behaves exactly like a plain monitor**, which
 * falls out of the rule rather than being special-cased: with one observable
 * region, "some down" and "all down" are the same set, so the DOWN branch is
 * reached first and DEGRADED can never be produced. That is worth stating
 * because a rule expressed as "more than zero and fewer than all" would instead
 * produce DEGRADED for a single down region, which would be nonsense.
 */
export function rollupRegionStatuses(samples: RegionSample[]): RegionRollup {
  const up: number[] = [];
  const degraded: number[] = [];
  const down: number[] = [];
  const maintenance: number[] = [];
  const silent: number[] = [];

  for (const sample of samples) {
    switch (sample.status) {
      case "UP":
        up.push(sample.regionId);
        break;
      case "DEGRADED":
        degraded.push(sample.regionId);
        break;
      case "DOWN":
        down.push(sample.regionId);
        break;
      case "MAINTENANCE":
        maintenance.push(sample.regionId);
        break;
      default:
        // Null, and equally an unrecognised string. An unknown status is not an
        // outage; "we do not know what this means" is the honest answer and it
        // is the same answer as silence.
        silent.push(sample.regionId);
    }
  }

  const observed = up.length + degraded.length + down.length;

  /**
   * **Latency comes from the serving regions only.**
   *
   * A down endpoint reports a latency of 0, so averaging it in makes a service
   * look FASTER the moment part of it fails - a graph that improves during an
   * outage. Maintenance and silent regions have nothing to contribute either.
   */
  const serving = samples.filter(
    (sample) =>
      (sample.status === "UP" || sample.status === "DEGRADED") &&
      typeof sample.latencyMs === "number" &&
      Number.isFinite(sample.latencyMs),
  );
  const latencyMs =
    serving.length > 0
      ? serving.reduce((total, sample) => total + (sample.latencyMs as number), 0) / serving.length
      : null;

  const base = { observed, down, degraded, maintenance, silent, latencyMs };

  if (observed === 0) {
    // Nothing observable. Maintenance is a statement; silence is not.
    return { ...base, status: maintenance.length > 0 ? "MAINTENANCE" : null };
  }

  // All down, which for a single-region service is simply "down".
  if (down.length === observed) return { ...base, status: "DOWN" };

  // Some down, or some merely degraded. Either way the service is not whole.
  if (down.length > 0 || degraded.length > 0) return { ...base, status: "DEGRADED" };

  return { ...base, status: "UP" };
}

/**
 * A sentence naming what is wrong, for an alert or an incident (Q2 and Q3).
 *
 * Enno decided that alerting fires per MONITOR and names the region, so this is
 * the half that names it. Returns the empty string when there is nothing to say,
 * so a caller can append it unconditionally without producing "Service is up ()".
 */
export function describeRollup(rollup: RegionRollup, nameForRegion: (regionId: number) => string): string {
  const parts: string[] = [];
  if (rollup.down.length > 0) parts.push(`down in ${rollup.down.map(nameForRegion).join(", ")}`);
  if (rollup.degraded.length > 0) parts.push(`degraded in ${rollup.degraded.map(nameForRegion).join(", ")}`);
  if (rollup.maintenance.length > 0)
    parts.push(`under maintenance in ${rollup.maintenance.map(nameForRegion).join(", ")}`);
  // Reported, because "we cannot see Frankfurt" is something an operator needs
  // to know and is invisible in the status itself.
  if (rollup.silent.length > 0) parts.push(`not reporting from ${rollup.silent.map(nameForRegion).join(", ")}`);
  return parts.join("; ");
}
