import type { MonitoringResult } from "../types/monitor.js";
import type { ProbeAgentRecord } from "../db/repositories/probes.js";
import { ERROR_CODES, type ErrorCode } from "./protocol.js";

/**
 * Who is connected right now (B1c).
 *
 * **Explicitly throwaway, and this is the file the note is about.** The registry
 * is a plain `Map` in the scheduler process's memory, so it is lost on restart
 * and invisible to a second instance. That is survivable only because of the
 * three other things B1c decided: assignment is push-based, there is one agent
 * per region, and a probe that cannot be reached falls back to a local check.
 * The full suite is pull-based precisely so that none of those hold - a pulled
 * assignment needs no registry at all, which is what makes quorum and
 * multi-instance possible.
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

/** `org:region` -> agent id. B1c allows one agent per region, and this is what enforces it. */
const byRegion = new Map<string, number>();

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
 * **A second agent for the same region is refused.** That is not a transient
 * state to resolve in favour of the newcomer: it is two differently-named agents
 * configured for one region, which B1c does not support, and silently preferring
 * whichever reconnected last would make the fleet's behaviour depend on network
 * luck. The screen already refuses to create the second one; this is the same
 * rule where a row inserted by hand would otherwise slip past.
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
  const holder = byRegion.get(key);
  if (holder !== undefined && holder !== agent.id) {
    return {
      ok: false,
      code: ERROR_CODES.REGION_TAKEN,
      reason: `region ${agent.region_id} is already served by agent ${holder}`,
    };
  }

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
  byRegion.set(key, agent.id);
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
  // Only if this agent is still the one holding the region. A replaced
  // connection has already handed the slot to its successor, and deleting the
  // key here would free a region that is in fact occupied.
  if (byRegion.get(key) === agentId) byRegion.delete(key);

  for (const pending of connection.pending.values()) {
    pending.resolve({ kind: "gone", reason });
  }
  connection.pending.clear();

  return connection;
}

export function getConnection(agentId: number): ProbeConnection | undefined {
  return byAgent.get(agentId);
}

/** The connection serving one region of one org, if any. */
export function connectionForRegion(orgId: number, regionId: number): ProbeConnection | undefined {
  const agentId = byRegion.get(regionKey(orgId, regionId));
  return agentId === undefined ? undefined : byAgent.get(agentId);
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
