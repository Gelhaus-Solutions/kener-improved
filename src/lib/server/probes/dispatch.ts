import type { MonitoringResult } from "../types/monitor.js";
import type { MonitorRecordTyped } from "../types/db.js";
import db from "../db/db.js";
import GC from "../../global-constants.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import { currentOrgIdOrDefault } from "../db/orgContext.js";
import { encode, newMessageId, type AssignMessage } from "./protocol.js";
import { getConnection, type AssignmentOutcome, type ProbeConnection } from "./registry.js";
import { resolveTypeDataSecrets } from "./secrets.js";
import type { ProbeTarget } from "../db/repositories/probes.js";
import {
  LOCAL_REGION_ID,
  resolveMergeConfig,
  parseMergeDefaults,
  DEFAULT_MERGE_DEFAULTS,
  type MergeConfig,
  type SourceMode,
} from "./merge.js";
import { GetSiteDataByKey } from "../controllers/siteDataController.js";

/**
 * Handing a check to a probe, and deciding when not to (B1c).
 *
 * **The rule this file encodes.** An agent's `region_id` says what its samples
 * mean, and region 0 is the merged, authoritative verdict every read in Kener
 * goes through (`db/regions.ts`).
 *
 * **B1d changed who decides, not what a region means.** Region 0 is still the
 * verdict every read goes through; it is now *computed* from the sources rather
 * than written by whichever source happened to be authoritative. So this file
 * stopped picking a winner and started building the list of observers, and the
 * merge in `merge.ts` decides what they add up to.
 *
 *   - An agent at **region >= 1** is a source at that region. Whether it is
 *     awaited and counted, merely recorded, or not dispatched at all is its
 *     resolved `mode` - `VOTE`, `DISPLAY_ONLY` or `OFF`.
 *   - An agent at **region 0** is *the local check, run remotely*. That is what
 *     B1c's region 0 already meant ("replaces the local check"), and under B1d
 *     nothing may observe at region 0 because region 0 is the computed answer.
 *     Its samples are therefore recorded at `LOCAL_REGION_ID` and the server does
 *     not also check locally. Existing agents keep working with no migration and
 *     no change in behaviour.
 *
 * **Local fallback is the point, not a detail.** For a status page the safest
 * possible failure mode is to check the thing yourself, so a probe holding the
 * local slot that is not connected, rejects the work, disappears mid-check or
 * simply does not answer in time all end the same way: `runOnProbe` returns null
 * and the worker runs the check locally in the same tick. Nothing is skipped
 * because a probe was having a bad minute.
 *
 * **Push-based, and explicitly throwaway.** The full suite pulls, which is what
 * makes quorum and multiple Kener instances possible. Everything here that knows
 * about a live socket goes with it; the message envelope, `region_id` end to
 * end, and the eligibility rule are what stay.
 */

/** How long to wait for a region-0 probe before checking it ourselves, when the monitor sets no timeout. */
const DEFAULT_ASSIGNMENT_TIMEOUT_MS = 10_000;

/**
 * Added to the monitor's own timeout to get the deadline for a remote check.
 *
 * The probe is running the same service class with the same timeout, so waiting
 * exactly that long would race its own answer and fall back to local at almost
 * the moment the result arrived - doubling the check and throwing away the one
 * that worked. The slack covers the round trip and the probe's own scheduling.
 */
const REMOTE_SLACK_MS = 5_000;

/** One connected agent, with the region its samples mean and the mode it observes under. */
export interface ProbeSource {
  connection: ProbeConnection;
  /** `LOCAL_REGION_ID` for an agent holding the local slot; otherwise its own region. */
  regionId: number;
  mode: SourceMode;
}

export interface ProbePlan {
  /** Dispatched, awaited, and counted by the merge. */
  voting: ProbeSource[];
  /** Dispatched and recorded at their own region; never awaited, never counted. */
  displayOnly: ProbeSource[];
  /**
   * The agent standing in for the local check, if one is connected.
   *
   * Held separately from `voting` because it is the one source whose failure has
   * a fallback: if it answers with nothing, the server runs the check itself in
   * the same tick rather than publishing a minute of silence.
   */
  localSlot: ProbeSource | null;
  /** The resolved cascade. Never null, so the caller never has to decide anything. */
  config: MergeConfig;
}

/** Whether a monitor type may be handed to a probe at all. */
export function isProbeEligible(monitorType: string): boolean {
  return (GC.PROBE_ELIGIBLE_TYPES as readonly string[]).includes(monitorType);
}

function timeoutForMonitor(monitor: MonitorRecordTyped): number {
  const configured = (monitor.type_data as { timeout?: unknown } | null | undefined)?.timeout;
  const ms = Number(configured);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_ASSIGNMENT_TIMEOUT_MS + REMOTE_SLACK_MS;
  return ms + REMOTE_SLACK_MS;
}

/**
 * An empty plan: nothing remote, local decides, shipped defaults.
 *
 * Built rather than shared, because a caller holding the config could mutate the
 * `sources` map of every other monitor's plan.
 */
function localOnlyPlan(): ProbePlan {
  return {
    voting: [],
    displayOnly: [],
    localSlot: null,
    config: resolveMergeConfig({
      instance: DEFAULT_MERGE_DEFAULTS,
      regions: [],
      participatingRegions: [LOCAL_REGION_ID],
    }),
  };
}

/**
 * Which connected agents observe this monitor's next check, and under what rules.
 *
 * Returns a local-only plan for an ineligible type without querying, so the
 * overwhelming majority of checks - every monitor nobody has assigned, and every
 * GROUP, HEARTBEAT and SQL monitor, which can never be remote - cost nothing.
 * **The cascade is only read for a monitor that actually has an assignment**,
 * which is what keeps B1d off the hot path of an install that uses no probes.
 *
 * An assignment whose agent is not currently connected is simply absent. That is
 * the fallback: it does not participate, the merge never waits for it, and if it
 * held the local slot the server checks locally instead.
 */
export async function planProbeExecution(monitor: MonitorRecordTyped): Promise<ProbePlan> {
  if (!isProbeEligible(monitor.monitor_type)) return localOnlyPlan();

  let targets: ProbeTarget[];
  try {
    targets = await db.getProbeTargetsForMonitor(monitor.tag);
  } catch (error) {
    // A failure to read the assignment table must never stop a check running.
    // Falling through to a local-only plan means the monitor is checked locally,
    // which is what it did before probes existed.
    console.error(`Probe assignment lookup failed for ${monitor.tag}, checking locally:`, error);
    return localOnlyPlan();
  }
  if (targets.length === 0) return localOnlyPlan();

  // Connected, capable agents, with the region each one's samples actually mean.
  const connected: Array<{ connection: ProbeConnection; regionId: number }> = [];
  let localSlotTaken = false;
  for (const target of targets) {
    const connection = getConnection(target.agent_id);
    if (!connection) continue;

    // The agent reports what it can actually run, and it is intersected with the
    // server's list rather than trusted: an old agent must never be handed a
    // check it does not implement, and a lying one must never be handed one the
    // server forbids. `capabilities` is null for an agent that reported none, in
    // which case the server's list alone decides.
    if (!agentSupports(connection, monitor.monitor_type)) continue;

    // An agent configured at region 0 is B1c's "replaces the local check". Under
    // B1d region 0 is the computed answer and nothing may observe there, so it
    // observes at the local region instead - which is what it always meant.
    const isLocalSlot = target.region_id === MERGED_REGION_ID;
    if (isLocalSlot) {
      // One agent per region means there can only be one; a hand-inserted second
      // row is ignored rather than both being awaited.
      if (localSlotTaken) continue;
      localSlotTaken = true;
    }
    connected.push({ connection, regionId: isLocalSlot ? LOCAL_REGION_ID : target.region_id });
  }

  const config = await resolveConfigFor(
    monitor.tag,
    // The local region participates whether or not a probe holds its slot: either
    // the server checks locally or an agent does it on the server's behalf, and
    // in both cases the observation is local's.
    [LOCAL_REGION_ID, ...connected.map((c) => c.regionId)],
  );

  const plan: ProbePlan = { voting: [], displayOnly: [], localSlot: null, config };
  for (const { connection, regionId } of connected) {
    const mode = config.sources.get(regionId)?.mode ?? "VOTE";
    if (mode === "OFF") continue;
    const source: ProbeSource = { connection, regionId, mode };
    if (regionId === LOCAL_REGION_ID) {
      plan.localSlot = source;
      // The local slot still votes or not like anything else; it is listed here
      // too so the merge sees it, and separately on `localSlot` so the worker
      // knows which failure has a fallback.
      if (mode === "VOTE") plan.voting.push(source);
      else plan.displayOnly.push(source);
      continue;
    }
    if (mode === "VOTE") plan.voting.push(source);
    else plan.displayOnly.push(source);
  }
  return plan;
}

/**
 * Reads the three levels and folds them into one config.
 *
 * Every read is individually non-fatal. A cascade that cannot be read must
 * degrade to the shipped defaults and let the check run, never stop a monitor
 * being checked: the defaults reproduce pre-B1d behaviour exactly, so the worst
 * case of a failure here is that a configured weight is ignored for a tick.
 */
async function resolveConfigFor(monitorTag: string, participatingRegions: number[]): Promise<MergeConfig> {
  let instance = DEFAULT_MERGE_DEFAULTS;
  let regions: Awaited<ReturnType<typeof db.getMergeRegions>> = [];
  let monitorPolicy = null;
  let monitorSources: Awaited<ReturnType<typeof db.getMonitorSourcePolicies>> = [];

  try {
    const [stored, regionRows, policyRow, sourceRows] = await Promise.all([
      GetSiteDataByKey("probeMergePolicy"),
      db.getMergeRegions(),
      db.getMonitorMergePolicy(monitorTag),
      db.getMonitorSourcePolicies(monitorTag),
    ]);
    instance = parseMergeDefaults(stored);
    regions = regionRows;
    monitorPolicy = policyRow ?? null;
    monitorSources = sourceRows;
  } catch (error) {
    console.error(`Merge policy lookup failed for ${monitorTag}, using the shipped defaults:`, error);
  }

  return resolveMergeConfig({ instance, regions, monitorPolicy, monitorSources, participatingRegions });
}

function agentSupports(connection: ProbeConnection, monitorType: string): boolean {
  const raw = connection.agent.capabilities;
  if (!raw) return true;
  try {
    const capabilities = JSON.parse(raw);
    return Array.isArray(capabilities) && capabilities.includes(monitorType);
  } catch {
    // A capabilities column that is not JSON is a corrupt row, not a claim of
    // support. Falling back to the server's list keeps the agent usable.
    return true;
  }
}

function buildAssign(monitor: MonitorRecordTyped, ts: number, timeoutMs: number): { id: string; frame: string } {
  const id = newMessageId("a");
  const message: AssignMessage = {
    v: 1,
    type: "assign",
    id,
    monitor_tag: monitor.tag,
    monitor_type: monitor.monitor_type,
    type_data: resolveTypeDataSecrets(monitor.type_data),
    ts,
    timeout_ms: timeoutMs,
  };
  return { id, frame: encode(message) };
}

/**
 * Sends one assignment and waits for the probe to answer it.
 *
 * Resolves to a `MonitoringResult` only when the probe actually produced one.
 * **Every other ending resolves to null**, which the caller reads as "check it
 * yourself": a reject, a dropped connection, a timeout, or a result for a
 * different minute than the one asked about.
 *
 * The wait is bounded and the timer is always cleared, including on the paths
 * that fail, so a probe that answers late cannot resolve a promise nobody is
 * holding any more.
 */
export function runOnProbe(
  connection: ProbeConnection,
  monitor: MonitorRecordTyped,
  ts: number,
): Promise<MonitoringResult | null> {
  const timeoutMs = timeoutForMonitor(monitor);
  const { id, frame } = buildAssign(monitor, ts, timeoutMs);

  return new Promise<MonitoringResult | null>((resolve) => {
    let settled = false;
    const finish = (value: MonitoringResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.pending.delete(id);
      resolve(value);
    };

    const timer = setTimeout(() => {
      console.warn(
        `Probe agent ${connection.agent.id} did not answer ${monitor.tag} within ${timeoutMs}ms, checking locally`,
      );
      finish(null);
    }, timeoutMs);
    // A pending assignment must never keep the process alive on its own. The
    // scheduler is shut down by closing its queues, and a timer with a reference
    // would hold the event loop open for the length of a monitor timeout.
    timer.unref?.();

    connection.pending.set(id, {
      monitor_tag: monitor.tag,
      ts,
      resolve: (outcome: AssignmentOutcome) => {
        if (outcome.kind === "result") {
          finish(outcome.result);
          return;
        }
        if (outcome.kind === "reject") {
          console.warn(`Probe agent ${connection.agent.id} rejected ${monitor.tag}: ${outcome.reason}`);
        }
        finish(null);
      },
    });

    connection.send(frame);
  });
}

/**
 * Sends an assignment to a region >= 1 agent without waiting for it.
 *
 * A regional sample is not on anybody's critical path: it writes a row and
 * drives nothing, so blocking the execute worker on it would add a monitor's
 * whole timeout to every tick in exchange for a sample that nothing reads
 * synchronously. If it never arrives, that region simply has a gap for that
 * minute, which is the honest record of what happened.
 *
 * The pending entry is still registered so that `handleResult` can find the
 * assignment and know which minute it belongs to; it resolves to nothing.
 */
export function dispatchSample(connection: ProbeConnection, monitor: MonitorRecordTyped, ts: number): void {
  const timeoutMs = timeoutForMonitor(monitor);
  const { id, frame } = buildAssign(monitor, ts, timeoutMs);

  const timer = setTimeout(() => {
    connection.pending.delete(id);
  }, timeoutMs);
  timer.unref?.();

  connection.pending.set(id, {
    monitor_tag: monitor.tag,
    ts,
    resolve: () => {
      clearTimeout(timer);
      connection.pending.delete(id);
    },
  });

  connection.send(frame);
}

/**
 * The org a connection's work belongs to.
 *
 * Read from the agent row rather than from the ambient context, because a result
 * arrives on a socket rather than inside a request or a job: there is no context
 * to inherit. `currentOrgIdOrDefault` is used only as the fallback for an agent
 * row that predates orgs.
 */
export function orgIdForConnection(connection: ProbeConnection): number {
  return connection.agent.org_id ?? currentOrgIdOrDefault();
}
