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

/**
 * Handing a check to a probe, and deciding when not to (B1c).
 *
 * **The rule this file encodes.** An agent's `region_id` says what its samples
 * mean, and region 0 is the merged, authoritative verdict every read in Kener
 * goes through (`db/regions.ts`).
 *
 *   - An agent at **region 0** *replaces* the local check. Its result flows
 *     through the execute worker's whole overlay, threshold and merge path
 *     exactly as a local one does, because it is the verdict, not a sample. This
 *     is what moves checking off the Kener host, and it is what
 *     `REMOTE_PREFERRED` means.
 *   - An agent at **region >= 1** *adds* a sample and nothing else. It is
 *     dispatched fire-and-forget and its result goes straight to
 *     `monitorResponseQueue` at its own region, where B1b's gate already ensures
 *     it writes a row and drives no cache, no alert and no status change.
 *
 * **Local fallback is the point, not a detail.** For a status page the safest
 * possible failure mode is to check the thing yourself, so a region-0 agent that
 * is not connected, rejects the work, disappears mid-check or simply does not
 * answer in time all end the same way: `runOnProbe` returns null and the worker
 * runs the check locally in the same tick. Nothing is skipped because a probe
 * was having a bad minute.
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

export interface ProbePlan {
  /** The connected region-0 agent that will replace the local check, if there is one. */
  merged: ProbeConnection | null;
  /** Connected agents at region >= 1, each of which gets a fire-and-forget sample. */
  samples: ProbeConnection[];
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
 * Which connected agents should be given this monitor's next check.
 *
 * Returns an empty plan for an ineligible type without querying, so the
 * overwhelming majority of checks - every monitor nobody has assigned, and every
 * GROUP, HEARTBEAT and SQL monitor, which can never be remote - cost nothing.
 *
 * An assignment whose agent is not currently connected is simply absent from the
 * plan. That is the fallback: the caller sees no merged agent and runs the check
 * itself, with no waiting and nothing to time out.
 */
export async function planProbeExecution(monitor: MonitorRecordTyped): Promise<ProbePlan> {
  const empty: ProbePlan = { merged: null, samples: [] };
  if (!isProbeEligible(monitor.monitor_type)) return empty;

  let targets: ProbeTarget[];
  try {
    targets = await db.getProbeTargetsForMonitor(monitor.tag);
  } catch (error) {
    // A failure to read the assignment table must never stop a check running.
    // Falling through to an empty plan means the monitor is checked locally,
    // which is what it did before probes existed.
    console.error(`Probe assignment lookup failed for ${monitor.tag}, checking locally:`, error);
    return empty;
  }
  if (targets.length === 0) return empty;

  const plan: ProbePlan = { merged: null, samples: [] };
  for (const target of targets) {
    const connection = getConnection(target.agent_id);
    if (!connection) continue;

    // The agent reports what it can actually run, and it is intersected with the
    // server's list rather than trusted: an old agent must never be handed a
    // check it does not implement, and a lying one must never be handed one the
    // server forbids. `capabilities` is null for an agent that reported none, in
    // which case the server's list alone decides.
    if (!agentSupports(connection, monitor.monitor_type)) continue;

    if (target.region_id === MERGED_REGION_ID) {
      // One agent per region means there can only be one of these; if a hand
      // inserted row produced two, the first wins and the rest are ignored
      // rather than both being awaited.
      if (!plan.merged) plan.merged = connection;
    } else {
      plan.samples.push(connection);
    }
  }
  return plan;
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
