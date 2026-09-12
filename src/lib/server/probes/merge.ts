import GC from "../../global-constants.js";
import type { MonitoringResult } from "../types/monitor.js";

/**
 * B1d. Turning several observations of one monitor into one published verdict.
 *
 * **This file is pure.** No database, no Redis, no clock, no registry. Everything
 * it needs arrives in its arguments, and that is deliberate: this is the piece
 * that decides what a status page tells the world, and a wrong answer here is
 * invisible in every other layer. Pure means it can be exhausted by unit tests
 * rather than inferred from a live run.
 *
 * ## What changed underneath it
 *
 * Before B1d there was no merge at all. `dispatch.ts` picked one authoritative
 * source - the region-0 probe if one was connected, otherwise the local check -
 * and every other probe's sample landed in a `monitoring_data` row that nothing
 * ever read. Weighted results, trusting a vantage point over the local check and
 * display-only regions were all impossible, because the verdict row was written
 * by whichever source happened to win the race to be authoritative.
 *
 * So the local check stopped being special. It is now a source like any other,
 * at `LOCAL_REGION_ID`, and region 0 became a **computed** row rather than
 * "whatever the winning source reported". Every read in Kener still asks for
 * region 0 and still gets one row per minute; what changed is who writes it.
 *
 * ## The policies
 *
 *   - `TRUST_ORDER`        the highest-ranked source that reported wins outright.
 *   - `WEIGHTED_MAJORITY`  statuses are tallied by weight; the heaviest wins.
 *   - `QUORUM_DOWN`        N sources must agree before DOWN is published.
 *
 * ## Disagreement, and why it is not one global rule
 *
 * `degradedOnDisagreement` applies under `WEIGHTED_MAJORITY` **only**, and it
 * only ever moves a verdict downwards: a winning UP with any worse voting source
 * becomes DEGRADED, and a winning DOWN is never softened.
 *
 * It deliberately does not apply to `TRUST_ORDER`. That policy exists for the
 * case where the local check is the one that is wrong - a provider that blocks
 * datacenter ranges answers 403 to the server and 200 to a residential probe -
 * and those two sources disagreeing is not a partial outage, it is the entire
 * reason the operator ranked them. A blanket disagreement rule would mean
 * TRUST_ORDER could never publish UP in exactly the situation it was chosen for.
 *
 * `QUORUM_DOWN` answers disagreement its own way too: below the threshold it
 * holds the last known status rather than publishing anything new.
 */

/**
 * The local check's region.
 *
 * Negative so it can never collide with `regions.id`, which is an `increments`
 * column and therefore always positive. Mirrors `MERGED_REGION_ID = 0` in
 * `db/regions.ts`: 0 is the computed verdict, -1 is the server's own
 * observation, and everything at `>= 1` is a probe.
 */
export const LOCAL_REGION_ID = -1;

/**
 * What a source is allowed to do.
 *
 *   - `VOTE`          dispatched, awaited, and counted in the verdict.
 *   - `DISPLAY_ONLY`  dispatched and recorded, never counted. Its row shows on
 *                     the region breakdown and moves nothing.
 *   - `OFF`           not dispatched at all. For the local source this also
 *                     means the server does not run the check itself.
 *
 * `DISPLAY_ONLY` is a mode rather than a weight of zero because zero weight is
 * meaningless under `TRUST_ORDER`, where rank and not weight decides. One field
 * that means the same thing under every policy beats three that do not.
 */
export type SourceMode = "VOTE" | "DISPLAY_ONLY" | "OFF";

export type MergePolicy = "TRUST_ORDER" | "WEIGHTED_MAJORITY" | "QUORUM_DOWN";

export const MERGE_POLICIES: readonly MergePolicy[] = ["TRUST_ORDER", "WEIGHTED_MAJORITY", "QUORUM_DOWN"];
export const SOURCE_MODES: readonly SourceMode[] = ["VOTE", "DISPLAY_ONLY", "OFF"];

/** One source's settings, after the cascade has been resolved. */
export interface SourceConfig {
  regionId: number;
  mode: SourceMode;
  /** `WEIGHTED_MAJORITY` only. Non-negative; a weight of 0 cannot carry a vote. */
  weight: number;
  /** `TRUST_ORDER` only. **Lower is more trusted**, like a Unix nice value. */
  trustRank: number;
}

/** The effective merge settings for one monitor, after the cascade. */
export interface MergeConfig {
  policy: MergePolicy;
  /** `QUORUM_DOWN` only: how many sources must report DOWN. Always >= 1. */
  quorumThreshold: number;
  /** `WEIGHTED_MAJORITY` only. See the note on disagreement above. */
  degradedOnDisagreement: boolean;
  sources: Map<number, SourceConfig>;
}

/** One source's answer for one minute. */
export interface Observation {
  regionId: number;
  result: MonitoringResult;
}

/**
 * The instance-wide defaults, stored in `site_data.probeMergePolicy`.
 *
 * It is an ordinary org-scoped key rather than an instance-scoped one, so each
 * tenant sets its own and I3g's site_data layering gives "instance default with
 * a per-org override" for free, with no machinery of its own.
 */
export interface InstanceMergeDefaults {
  policy: MergePolicy;
  quorumThreshold: number;
  degradedOnDisagreement: boolean;
  /** Applied to any source whose region does not set its own. */
  defaultWeight: number;
  defaultTrustRank: number;
  defaultMode: SourceMode;
  /** The local check's own defaults, which have no `regions` row to read. */
  localWeight: number;
  localTrustRank: number;
  localMode: SourceMode;
}

/**
 * Shipped defaults, chosen so that an instance which configures nothing behaves
 * exactly as it did before B1d.
 *
 * `WEIGHTED_MAJORITY` with every weight at 1 and a single source is that source.
 * Add one probe and it becomes a two-way vote resolving ties to the worse
 * status, which is the conservative direction for a status page. Disagreement
 * does **not** produce DEGRADED by default: turning a disagreement into a
 * publicly visible degradation is a change to what the page says about somebody's
 * service, and an upgrade must never start doing that on its own.
 *
 * Local's trust rank is deliberately the lowest number of the two defaults, so
 * that switching to TRUST_ORDER without configuring anything keeps the local
 * check authoritative rather than silently handing the verdict to a probe.
 */
export const DEFAULT_MERGE_DEFAULTS: InstanceMergeDefaults = {
  policy: "WEIGHTED_MAJORITY",
  quorumThreshold: 2,
  degradedOnDisagreement: false,
  defaultWeight: 1,
  defaultTrustRank: 100,
  defaultMode: "VOTE",
  localWeight: 1,
  localTrustRank: 50,
  localMode: "VOTE",
};

/** A `regions` row's cascade columns. Null means "inherit". */
export interface RegionDefaults {
  id: number;
  default_weight?: number | null;
  default_trust_rank?: number | null;
  default_mode?: string | null;
}

/** A `monitor_merge_policies` row. Every field nullable: null means "inherit". */
export interface MonitorPolicyRow {
  policy?: string | null;
  quorum_threshold?: number | null;
  degraded_on_disagreement?: boolean | number | null;
}

/** A `monitor_source_policies` row. Every field nullable: null means "inherit". */
export interface MonitorSourceRow {
  region_id: number;
  weight?: number | null;
  trust_rank?: number | null;
  mode?: string | null;
}

function asPolicy(raw: unknown, fallback: MergePolicy): MergePolicy {
  return typeof raw === "string" && (MERGE_POLICIES as readonly string[]).includes(raw)
    ? (raw as MergePolicy)
    : fallback;
}

function asMode(raw: unknown, fallback: SourceMode): SourceMode {
  return typeof raw === "string" && (SOURCE_MODES as readonly string[]).includes(raw) ? (raw as SourceMode) : fallback;
}

/**
 * A number that is actually present.
 *
 * `null` and `undefined` mean "inherit", and 0 does not: a weight of 0 is a real
 * setting meaning "this source cannot carry a vote". Anything non-finite is
 * treated as absent rather than as 0, so a corrupt column inherits instead of
 * silently disenfranchising a region.
 */
function present(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function presentBool(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null;
  // SQLite hands booleans back as 0/1.
  if (typeof raw === "number") return raw !== 0;
  return raw === true;
}

/**
 * Folds the three levels into the one config the merge actually runs on.
 *
 * **The cascade is not uniform, and that is deliberate.** The *policy* resolves
 * instance then monitor; the *per-source attributes* resolve region then
 * monitor. A policy cannot vary per region because it is the rule for combining
 * regions - "this region uses quorum and that one uses trust order" describes
 * nothing. Together they are the three levels an operator asked for, and each
 * setting lives at every level where it has a meaning.
 *
 * `participatingRegions` is what the monitor could actually hear from this tick:
 * the local source plus the region of every agent assigned to it. A region with
 * no configuration anywhere still gets an entry, built from the instance
 * defaults, so a probe added and never configured votes normally instead of
 * being silently ignored.
 */
export function resolveMergeConfig(input: {
  instance: InstanceMergeDefaults;
  regions: RegionDefaults[];
  monitorPolicy?: MonitorPolicyRow | null;
  monitorSources?: MonitorSourceRow[];
  participatingRegions: number[];
}): MergeConfig {
  const { instance, monitorPolicy } = input;
  const regionById = new Map(input.regions.map((r) => [r.id, r]));
  const overrideByRegion = new Map((input.monitorSources ?? []).map((s) => [s.region_id, s]));

  const sources = new Map<number, SourceConfig>();
  for (const regionId of new Set(input.participatingRegions)) {
    const region = regionById.get(regionId);
    const override = overrideByRegion.get(regionId);
    const isLocal = regionId === LOCAL_REGION_ID;

    // Local reads its instance defaults from their own fields. It has a
    // `regions` row so the admin screen can list it beside the probes, but its
    // instance-level defaults are named separately: "the default for a probe
    // region" and "the default for the server's own check" are different
    // questions and an operator should not have to answer them with one number.
    const baseWeight = isLocal ? instance.localWeight : instance.defaultWeight;
    const baseTrust = isLocal ? instance.localTrustRank : instance.defaultTrustRank;
    const baseMode = isLocal ? instance.localMode : instance.defaultMode;

    sources.set(regionId, {
      regionId,
      weight: Math.max(0, present(override?.weight) ?? present(region?.default_weight) ?? baseWeight),
      trustRank: present(override?.trust_rank) ?? present(region?.default_trust_rank) ?? baseTrust,
      mode: asMode(override?.mode, asMode(region?.default_mode, baseMode)),
    });
  }

  return {
    policy: asPolicy(monitorPolicy?.policy, instance.policy),
    quorumThreshold: Math.max(1, Math.floor(present(monitorPolicy?.quorum_threshold) ?? instance.quorumThreshold)),
    degradedOnDisagreement: presentBool(monitorPolicy?.degraded_on_disagreement) ?? instance.degradedOnDisagreement,
    sources,
  };
}

/**
 * Reads the stored instance defaults, falling back field by field.
 *
 * Per field rather than all-or-nothing, matching `parseThreshold` in
 * `services/latencyThreshold.ts` and for the same reason: an object written
 * before a field existed would otherwise be discarded wholesale, silently
 * resetting somebody's configured policy.
 */
export function parseMergeDefaults(raw: unknown): InstanceMergeDefaults {
  const base = DEFAULT_MERGE_DEFAULTS;
  if (!raw || typeof raw !== "object") return { ...base };
  const o = raw as Record<string, unknown>;
  return {
    policy: asPolicy(o.policy, base.policy),
    quorumThreshold: Math.max(1, Math.floor(present(o.quorumThreshold) ?? base.quorumThreshold)),
    degradedOnDisagreement: presentBool(o.degradedOnDisagreement) ?? base.degradedOnDisagreement,
    defaultWeight: Math.max(0, present(o.defaultWeight) ?? base.defaultWeight),
    defaultTrustRank: present(o.defaultTrustRank) ?? base.defaultTrustRank,
    defaultMode: asMode(o.defaultMode, base.defaultMode),
    localWeight: Math.max(0, present(o.localWeight) ?? base.localWeight),
    localTrustRank: present(o.localTrustRank) ?? base.localTrustRank,
    localMode: asMode(o.localMode, base.localMode),
  };
}

/**
 * Severity, for resolving ties and for "worse than".
 *
 * `NO_DATA` is deliberately absent: a source that produced no data did not vote,
 * and it is filtered out before any of this runs. Giving it a rank would let a
 * silent probe outvote a speaking one.
 */
const SEVERITY: Record<string, number> = {
  [GC.UP]: 1,
  [GC.DEGRADED]: 2,
  [GC.DOWN]: 3,
};

function severityOf(status: string): number {
  return SEVERITY[status] ?? 0;
}

function worseOf(a: string, b: string): string {
  return severityOf(a) >= severityOf(b) ? a : b;
}

/** Mean latency across a group, rounded. Empty groups report 0, as an absent check does. */
function meanLatency(observations: Observation[]): number {
  if (observations.length === 0) return 0;
  const total = observations.reduce((sum, o) => sum + (Number(o.result.latency) || 0), 0);
  return Math.round(total / observations.length);
}

/**
 * The error text the verdict carries.
 *
 * Taken from the worst-status observation that has one, because that is the
 * source whose complaint explains the verdict. A merged row that says DOWN with
 * the *healthy* region's empty message would be actively misleading to whoever
 * opens the monitor to find out what broke.
 */
function errorFor(status: string, observations: Observation[]): string | undefined {
  const matching = observations.filter((o) => o.result.status === status && o.result.error_message);
  if (matching.length === 0) return undefined;
  if (matching.length === 1) return matching[0].result.error_message;
  // Several regions failing for different reasons is worth saying out loud
  // rather than picking one arbitrarily and hiding the rest.
  return matching.map((o) => `${regionLabel(o.regionId)}: ${o.result.error_message}`).join(" | ");
}

function regionLabel(regionId: number): string {
  return regionId === LOCAL_REGION_ID ? "local" : `region ${regionId}`;
}

/** The sources that are allowed to decide anything, with their config attached. */
function votingObservations(
  observations: Observation[],
  config: MergeConfig,
): Array<Observation & { config: SourceConfig }> {
  const voting: Array<Observation & { config: SourceConfig }> = [];
  for (const observation of observations) {
    // A source with no configured entry votes on defaults rather than being
    // silently dropped: an operator who adds a region and forgets to configure
    // it should get an equal vote, not an ignored probe.
    const source = config.sources.get(observation.regionId) ?? {
      regionId: observation.regionId,
      mode: "VOTE" as SourceMode,
      weight: 1,
      trustRank: 100,
    };
    if (source.mode !== "VOTE") continue;
    // A source that produced no data did not observe anything. It must not be
    // able to outvote a source that did, and under QUORUM_DOWN it must not
    // count towards M either.
    if (severityOf(observation.result.status) === 0) continue;
    voting.push({ ...observation, config: source });
  }
  return voting;
}

/**
 * Combines observations into the row that will be written at region 0.
 *
 * Returns **null** when nothing could decide - no observation at all, or every
 * source silent, misconfigured to `OFF`, or reporting `NO_DATA`. The caller
 * reads null as "fall back to the local check", which is the same answer B1c
 * gives for every unhappy probe ending: for a status page, checking the thing
 * yourself is the safest thing to do when the fleet is unreliable.
 *
 * `lastKnownStatus` is only read by `QUORUM_DOWN`, and only below the threshold.
 */
export function mergeObservations(
  observations: Observation[],
  config: MergeConfig,
  lastKnownStatus?: string,
): MonitoringResult | null {
  const voting = votingObservations(observations, config);
  if (voting.length === 0) return null;

  switch (config.policy) {
    case "TRUST_ORDER":
      return mergeByTrustOrder(voting);
    case "QUORUM_DOWN":
      return mergeByQuorum(voting, config, lastKnownStatus);
    case "WEIGHTED_MAJORITY":
    default:
      return mergeByWeight(voting, config);
  }
}

/**
 * The most trusted source that spoke wins, outright.
 *
 * No averaging and no blending: the point of ranking sources is that the
 * operator has decided one of them is *right* and the others are noise in this
 * particular case. Ties break towards the lower region id so the result is
 * stable rather than dependent on query order, and local (-1) wins a tie by
 * construction, which matches "nothing beats checking it yourself unless you
 * said so explicitly".
 */
function mergeByTrustOrder(voting: Array<Observation & { config: SourceConfig }>): MonitoringResult {
  const ranked = [...voting].sort((a, b) => {
    if (a.config.trustRank !== b.config.trustRank) return a.config.trustRank - b.config.trustRank;
    return a.regionId - b.regionId;
  });
  const winner = ranked[0];
  return {
    status: winner.result.status,
    latency: Number(winner.result.latency) || 0,
    type: winner.result.type,
    ...(winner.result.error_message ? { error_message: winner.result.error_message } : {}),
  };
}

/**
 * Statuses tallied by weight; the heaviest wins.
 *
 * Ties resolve to the **worse** status. A status page that rounds a tie towards
 * UP is a status page that tells people everything is fine while half its
 * vantage points disagree.
 *
 * Latency comes from the winning group alone. Averaging in the losers would
 * blend the latency of a region that timed out into a verdict of UP.
 */
function mergeByWeight(voting: Array<Observation & { config: SourceConfig }>, config: MergeConfig): MonitoringResult {
  const weightByStatus = new Map<string, number>();
  for (const observation of voting) {
    const weight = Math.max(0, Number(observation.config.weight) || 0);
    weightByStatus.set(observation.result.status, (weightByStatus.get(observation.result.status) ?? 0) + weight);
  }

  let winner = "";
  let winningWeight = -1;
  for (const [status, weight] of weightByStatus) {
    if (weight > winningWeight || (weight === winningWeight && severityOf(status) > severityOf(winner))) {
      winner = status;
      winningWeight = weight;
    }
  }

  // Every voting source carried weight 0, so the tally decided nothing. Fall
  // back to the worst observed status rather than to whichever key was inserted
  // first: zero weight everywhere is a misconfiguration, and a misconfiguration
  // must not be able to publish UP over a source that reported DOWN.
  if (winningWeight <= 0) {
    winner = voting.reduce<string>((worst, o) => worseOf(worst, o.result.status), GC.UP);
  }

  const winningGroup = voting.filter((o) => o.result.status === winner);
  let status = winner;

  // Downwards only. A winning DOWN with one region reporting UP is still DOWN:
  // softening it would hide a real outage from the people in the affected
  // region, which is the wrong direction for a status page to be wrong in.
  if (config.degradedOnDisagreement && status === GC.UP) {
    const dissenting = voting.some((o) => severityOf(o.result.status) > severityOf(GC.UP));
    if (dissenting) status = GC.DEGRADED;
  }

  const result: MonitoringResult = {
    status,
    latency: meanLatency(winningGroup),
    type: winningGroup[0]?.result.type ?? voting[0].result.type,
  };

  // When disagreement downgraded UP to DEGRADED, the explanation lives with the
  // sources that dissented, not with the ones that voted UP and carry no message.
  const explaining = status === GC.DEGRADED && winner === GC.UP ? worstStatusPresent(voting) : status;
  const error = errorFor(explaining, voting);
  if (error) result.error_message = error;
  return result;
}

function worstStatusPresent(voting: Array<Observation & { config: SourceConfig }>): string {
  return voting.reduce<string>((worst, o) => worseOf(worst, o.result.status), GC.UP);
}

/**
 * DOWN only once enough sources agree; below that, hold what was already published.
 *
 * This is the cure for one flaky vantage point paging everybody at 03:00, and
 * holding is the deliberate choice over publishing DEGRADED: the operator who
 * picks a quorum is saying that a minority report is not yet news. The held row
 * still carries the dissenting region's error text, so the evidence is in the
 * history even though the status did not move.
 *
 * With no last known status - a monitor's first ever tick - the hold falls to UP
 * rather than inventing a DOWN the quorum explicitly refused to declare.
 */
function mergeByQuorum(
  voting: Array<Observation & { config: SourceConfig }>,
  config: MergeConfig,
  lastKnownStatus?: string,
): MonitoringResult {
  const down = voting.filter((o) => o.result.status === GC.DOWN);
  const threshold = Math.max(1, Math.floor(Number(config.quorumThreshold) || 1));

  if (down.length >= threshold) {
    const result: MonitoringResult = {
      status: GC.DOWN,
      latency: meanLatency(down),
      type: down[0].result.type,
    };
    const error = errorFor(GC.DOWN, voting);
    if (error) result.error_message = error;
    return result;
  }

  if (down.length === 0) {
    // Nobody is reporting DOWN, so the quorum has nothing to hold back. Publish
    // the worst thing actually observed, which is how DEGRADED still surfaces
    // under a policy that only ever gates DOWN.
    const status = worstStatusPresent(voting);
    const group = voting.filter((o) => o.result.status === status);
    const result: MonitoringResult = {
      status,
      latency: meanLatency(group),
      type: group[0].result.type,
    };
    const error = errorFor(status, voting);
    if (error) result.error_message = error;
    return result;
  }

  const held = lastKnownStatus && severityOf(lastKnownStatus) > 0 ? lastKnownStatus : GC.UP;
  const healthy = voting.filter((o) => o.result.status !== GC.DOWN);
  const shortfall = `${down.length} of ${voting.length} sources reported down, quorum is ${threshold}; holding ${held}`;
  const reported = errorFor(GC.DOWN, voting);
  return {
    status: held,
    // From the sources that are still answering: the DOWN ones usually timed
    // out, and folding a timeout into the latency of a held UP would put a
    // spike on the graph for a minute nothing actually got slower.
    latency: meanLatency(healthy.length > 0 ? healthy : voting),
    type: GC.REALTIME,
    error_message: reported ? `${shortfall} | ${reported}` : shortfall,
  };
}
