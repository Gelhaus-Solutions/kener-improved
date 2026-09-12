import type { MonitoringResult } from "../types/monitor.js";
import type { ProbeAgentRecord } from "../db/repositories/probes.js";
import { ERROR_CODES, type ErrorCode } from "./protocol.js";

/**
 * Who is connected right now (B1c).
 *
 * **Explicitly throwaway, and this is the file the note is about.** The registry
 * is a plain `Map` in the scheduler process's memory, so it is lost on restart
 * and invisible to a second instance. That is survivable because of the two
 * other things B1c decided: assignment is push-based, and a probe that cannot be
 * reached falls back to a local check. The full suite is pull-based precisely so
 * that neither has to hold - a pulled assignment needs no registry at all, which
 * is what makes quorum and multi-instance possible.
 *
 * B1c's third condition, one agent per region, is gone: a region may now be
 * served by any number of agents, which are replicas reduced to that region's
 * single verdict before the merge sees them. That changed this file from a slot
 * per region to a set per region, and it changed nothing about the other two.
 *
 * So: nothing outside this directory should learn the shape of a connection, and
 * nothing should persist anything from it. `connection_state` on `probe_agents`
 * is a *reflection* of this map for the admin screen to read, never the other
 * way round.
 */

/** What a probe eventually says about an assignment. */
export type AssignmentOutcome =
  | { kind: "result"; result: MonitoringResult }
  | { kind: "reject"; reason: string }
  | { kind: "gone"; reason: string };

/**
 * An assignment sent and not yet answered.
 *
 * The monitor and minute are held alongside the resolver because a `result`
 * frame is trusted for its *payload*, never for which check it belongs to: the
 * server matched the correlation id, so the tag and timestamp it stores here are
 * what the sample is recorded under. A probe that echoed a different tag would
 * otherwise write one monitor's result onto another's history.
 */
export interface PendingAssignment {
  monitor_tag: string;
  ts: number;
  /**
   * Whether the socket side writes this result's row, or somebody else does.
   *
   * **Two writers for one row is the failure this field exists to stop.** The
   * response queue deduplicates on `${tag}-${region}-${ts}`, with no agent in the
   * key, and `monitoring_data` is keyed the same way. So every result recorded
   * here competes for the same row as the execute worker's own write, and with
   * several agents in a region they no longer carry the same value: the worker
   * writes the region's merged verdict and each agent would write its own raw
   * answer over the top, whichever landed last.
   *
   * `false` for an awaited assignment (`runOnProbe`): the execute worker is
   * holding the promise and writes the merged row itself. `true` for a
   * fire-and-forget sample (`dispatchSample`), where nobody is waiting and this
   * is the only chance to record it.
   */
  recordsSample: boolean;
  resolve: (outcome: AssignmentOutcome) => void;
}

export interface ProbeConnection {
  agent: ProbeAgentRecord;
  /** Sends one already-encoded frame. Swallows a write to a dead socket. */
  send: (frame: string) => void;
  /** Closes the socket. */
  close: (code: number, reason: string) => void;
  /** UTC seconds of the last `heartbeat` frame, or of connect. */
  lastHeartbeatAt: number;
  /** Consecutive sweeps that found no new heartbeat. Three means offline. */
  missedHeartbeats: number;
  /** Whether `probe.disconnected` has already been emitted for this silence. */
  disconnectedEmitted: boolean;
  /**
   * Assignments sent and not yet answered, keyed by the `assign` message id.
   *
   * Held here rather than in `dispatch.ts` so that a dropped connection can fail
   * them all at once. Without that, a worker awaiting a probe that has just gone
   * would sit until its timeout expired before falling back to a local check,
   * turning a clean disconnect into a stalled minute.
   */
  pending: Map<string, PendingAssignment>;
}

/** agent id -> connection. One connection per agent. */
const byAgent = new Map<number, ProbeConnection>();

/**
 * `org:region` -> the agent ids serving it.
 *
 * A set rather than a single id: a region may be served by any number of agents,
 * which are replicas of one vantage point rather than independent voters. The
 * merge collapses them to one answer per region per minute
 * (`mergeRegionAgents`), which is also the only shape `monitoring_data`'s
 * `(monitor_tag, region_id, timestamp)` key can hold.
 */
const byRegion = new Map<string, Set<number>>();

function regionKey(orgId: number, regionId: number): string {
  return `${orgId}:${regionId}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export type RegisterResult = { ok: true; connection: ProbeConnection } | { ok: false; code: ErrorCode; reason: string };

/**
 * Adds a freshly authenticated connection.
 *
 * **A second connection for the same agent replaces the first.** A probe whose
 * network dropped reconnects while the server still believes the old socket is
 * alive, and refusing the new one would leave the agent unreachable until the
 * sweeper noticed - the common case, failing in the worst way. The old socket is
 * closed and its pending work failed, so the worker awaiting it falls back at
 * once rather than waiting for a timeout.
 *
 * **A second agent for the same region is accepted, and joins it.** Agents in a
 * region are replicas of one vantage point: they are all dispatched, and their
 * answers are reduced to the single verdict that region reports before anything
 * else sees them. So there is no slot to take and nothing to refuse, and a
 * region with two agents keeps answering when one of them is down, which is the
 * entire reason to deploy the second.
 */
export function register(
  agent: ProbeAgentRecord,
  send: (frame: string) => void,
  close: (code: number, reason: string) => void,
): RegisterResult {
  const existing = byAgent.get(agent.id);
  if (existing) {
    unregister(agent.id, "replaced by a new connection from the same agent");
    existing.close(1012, "replaced by a newer connection");
  }

  const key = regionKey(agent.org_id, agent.region_id);

  const connection: ProbeConnection = {
    agent,
    send,
    close,
    lastHeartbeatAt: nowSeconds(),
    missedHeartbeats: 0,
    disconnectedEmitted: false,
    pending: new Map(),
  };

  byAgent.set(agent.id, connection);
  const serving = byRegion.get(key) ?? new Set<number>();
  serving.add(agent.id);
  byRegion.set(key, serving);
  return { ok: true, connection };
}

/**
 * Removes a connection and fails everything it owed.
 *
 * Every pending assignment is resolved with `gone` rather than left to time out,
 * which is what makes the fallback immediate.
 */
export function unregister(agentId: number, reason: string): ProbeConnection | undefined {
  const connection = byAgent.get(agentId);
  if (!connection) return undefined;

  byAgent.delete(agentId);
  const key = regionKey(connection.agent.org_id, connection.agent.region_id);
  // Only this agent's own membership. Its siblings keep serving the region, and
  // the key is dropped only once the last of them has gone, so an empty set
  // never lingers to make a region look occupied.
  const serving = byRegion.get(key);
  if (serving) {
    serving.delete(agentId);
    if (serving.size === 0) byRegion.delete(key);
  }

  for (const pending of connection.pending.values()) {
    pending.resolve({ kind: "gone", reason });
  }
  connection.pending.clear();

  return connection;
}

export function getConnection(agentId: number): ProbeConnection | undefined {
  return byAgent.get(agentId);
}

/**
 * Every connection serving one region of one org, in agent id order.
 *
 * Ordered rather than returned in insertion order, because the intra-region
 * merge ranks agents by their position in this list under `TRUST_ORDER`. A list
 * whose order depended on who reconnected last would make that policy's answer
 * depend on network luck.
 */
export function connectionsForRegion(orgId: number, regionId: number): ProbeConnection[] {
  const serving = byRegion.get(regionKey(orgId, regionId));
  if (!serving) return [];
  return [...serving]
    .sort((a, b) => a - b)
    .map((agentId) => byAgent.get(agentId))
    .filter((connection): connection is ProbeConnection => connection !== undefined);
}

export function allConnections(): ProbeConnection[] {
  return [...byAgent.values()];
}

export function connectedAgentIds(): number[] {
  return [...byAgent.keys()];
}

/** Records that a probe spoke. Resets the missed count, which is what the sweeper reads. */
export function noteHeartbeat(agentId: number): void {
  const connection = byAgent.get(agentId);
  if (!connection) return;
  connection.lastHeartbeatAt = nowSeconds();
  connection.missedHeartbeats = 0;
  connection.disconnectedEmitted = false;
}

/**
 * Drops every connection.
 *
 * Shutdown only. `wsServer.shutdown` closes the sockets itself; this clears the
 * bookkeeping so that a restart inside one process (which the tests do) does not
 * start with a map full of agents whose sockets are gone.
 */
export function clear(reason: string): void {
  for (const agentId of [...byAgent.keys()]) {
    unregister(agentId, reason);
  }
  byAgent.clear();
  byRegion.clear();
}
