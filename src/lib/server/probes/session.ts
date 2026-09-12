import type { WebSocket } from "ws";
import db from "../db/db.js";
import { runWithOrg } from "../db/orgContext.js";
import { emit } from "../events/emit.js";
import { MERGED_REGION_ID } from "../db/regions.js";
import monitorResponseQueue from "../queues/monitorResponseQueue.js";
import type { MonitoringResult } from "../types/monitor.js";
import { authenticateProbe } from "./auth.js";
import {
  ERROR_CODES,
  encode,
  newMessageId,
  parseMessage,
  type ErrorCode,
  type ProbeMessage,
  type ResultMessage,
} from "./protocol.js";
import * as registry from "./registry.js";
import type { ProbeConnection } from "./registry.js";

/**
 * One probe's connection, from `hello` to `bye` (B1c).
 *
 * **The state machine is two states and that is deliberate.** A socket is either
 * pre-`hello` - in which case exactly one message type is accepted and nothing
 * else in Kener knows the connection exists - or authenticated, in which case it
 * is in the registry and may be assigned work. There is no half-open state where
 * an unauthenticated stranger can make the server do anything but parse a frame
 * and close.
 *
 * **Everything a probe says is treated as a claim, never as an instruction.** A
 * `result` is matched to an assignment the *server* sent, by correlation id, and
 * recorded under the tag and minute the server chose; the frame's own
 * `monitor_tag` and `ts` are checked against those and the frame is dropped when
 * they disagree. A probe therefore cannot write a result for a monitor it was
 * never given, nor backdate one into a minute it was not asked about, which is
 * the whole of what a compromised probe would otherwise be able to do to the
 * history.
 */

/**
 * How often a probe must speak, and how long the server waits before acting.
 *
 * The server tells the probe this value in `ready` so the two can never drift
 * into a fleet that marks itself offline. Three missed sweeps is the item's
 * rule: 90 seconds of silence, which is long enough to survive a slow check or a
 * brief network stall and short enough that a dead probe is noticed within two
 * cron ticks.
 */
export const HEARTBEAT_INTERVAL_SECONDS = 30;
export const MISSED_HEARTBEATS_BEFORE_OFFLINE = 3;

/** How long an unauthenticated socket may stay open before it is closed. */
const HELLO_TIMEOUT_MS = 10_000;

/**
 * How often `last_seen_at` is written back.
 *
 * A heartbeat arrives every 30 seconds per agent and the column exists so an
 * operator can see roughly when a probe was last alive. Writing on every one
 * would add a row update per agent per half minute for a value nothing reads
 * with any precision, so it is written at most once a minute and always on the
 * transitions that matter.
 */
const LAST_SEEN_WRITE_INTERVAL_SECONDS = 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sendError(socket: WebSocket, code: ErrorCode, message: string): void {
  try {
    socket.send(encode({ type: "error", id: newMessageId("e"), code, message }));
  } catch {
    // The socket is already gone. The close below is the only thing left to do
    // and it is safe to call on a dead socket.
  }
}

/**
 * Persists what a connection observed about an agent.
 *
 * Wrapped in `runWithOrg` because a socket is neither a request nor a BullMQ job:
 * there is no ambient org context to inherit, and `probe_agents` is a tenant
 * table whose scoped queries throw without one. The org comes from the agent row
 * the token resolved to, which is the only trustworthy source for it here.
 */
async function recordConnectionState(
  agent: { id: number; org_id: number },
  patch: {
    connection_state: string;
    last_seen_at?: number | null;
    agent_version?: string | null;
    capabilities?: string | null;
  },
): Promise<void> {
  try {
    await runWithOrg(agent.org_id, () => db.setProbeAgentConnection(agent.id, patch));
  } catch (error) {
    // Bookkeeping for a screen. A probe must keep working when it fails.
    console.error(`Could not record probe agent ${agent.id} connection state:`, error);
  }
}

export async function emitProbeEvent(
  agent: { id: number; org_id: number; name: string; region_id: number },
  type: "probe.connected" | "probe.disconnected" | "probe.offline" | "probe.result_late",
  payload: Record<string, unknown> = {},
): Promise<void> {
  const occurredAt = nowSeconds();
  try {
    await runWithOrg(agent.org_id, () =>
      emit({
        org_id: agent.org_id,
        type,
        aggregate_id: String(agent.id),
        // One event per agent per transition per second. A probe flapping inside
        // one second is one event, which is what an operator wants to read.
        idempotency_key: `${type}:${agent.id}:${occurredAt}`,
        occurred_at: occurredAt,
        payload: {
          agent_id: agent.id,
          agent_name: agent.name,
          region_id: agent.region_id,
          ...payload,
        },
      }),
    );
  } catch (error) {
    console.error(`Could not emit ${type} for probe agent ${agent.id}:`, error);
  }
}

/**
 * Wires up one accepted socket.
 *
 * Returns nothing: everything after this point is driven by frames arriving, and
 * the caller (`wsServer`) only needs to know the socket has been taken over.
 */
export function handleConnection(socket: WebSocket): void {
  let connection: ProbeConnection | null = null;
  let lastSeenWrittenAt = 0;

  // A socket that connects and says nothing holds a file descriptor for as long
  // as the process lives. Closing it is not a security measure so much as
  // hygiene: a port scanner should not be able to accumulate sockets.
  const helloTimer = setTimeout(() => {
    if (connection) return;
    sendError(socket, ERROR_CODES.NOT_READY, "no hello received");
    socket.close(1002, "no hello received");
  }, HELLO_TIMEOUT_MS);
  helloTimer.unref?.();

  const close = (code: number, reason: string) => {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  };

  socket.on("message", (raw: unknown) => {
    // Every handler below is async and nothing awaits them: `ws` does not
    // serialise handlers, so a rejected promise here would be unhandled. Each
    // path therefore catches its own failures and the outer catch is the
    // backstop for anything missed.
    void onMessage(String(raw)).catch((error) => {
      console.error("Probe session failed handling a frame:", error);
    });
  });

  socket.on("close", () => {
    clearTimeout(helloTimer);
    if (!connection) return;
    const closing = connection;
    const agent = closing.agent;
    connection = null;

    // Only if this socket is still the registered one. Two other things close a
    // socket and both have already recorded the transition themselves: the
    // sweeper, which reaps a silent probe as OFFLINE, and `register`, which
    // replaces a reconnecting agent's old connection. Without this check, the
    // close they cause would immediately overwrite OFFLINE with DISCONNECTED and
    // emit a second event for one departure.
    if (registry.getConnection(agent.id) !== closing) return;

    registry.unregister(agent.id, "the probe closed its connection");
    void recordConnectionState(agent, { connection_state: "DISCONNECTED", last_seen_at: nowSeconds() });
    void emitProbeEvent(agent, "probe.disconnected", { cause: "closed" });
  });

  socket.on("error", () => {
    // `ws` emits error then close, so the close handler above does the cleanup.
    // Swallowed here so a probe dying mid-frame cannot reach the process.
  });

  async function onMessage(raw: string): Promise<void> {
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      sendError(socket, parsed.code, parsed.reason);
      // A frame the server cannot understand is not fatal on its own, but a
      // version mismatch is: nothing the peer sends afterwards will be any more
      // intelligible, and leaving the socket open invites a loop.
      if (parsed.code === ERROR_CODES.BAD_VERSION) close(1002, parsed.reason);
      return;
    }

    const message = parsed.message;

    if (!connection) {
      if (message.type !== "hello") {
        sendError(socket, ERROR_CODES.NOT_READY, "authenticate with hello first");
        close(1002, "not authenticated");
        return;
      }
      await onHello(message);
      return;
    }

    switch (message.type) {
      case "hello":
        // Re-authenticating on a live connection is not a way to change agent
        // mid-stream. The registry is keyed by agent id and pending assignments
        // belong to the one that was authenticated, so honouring this would
        // deliver another agent's results under the wrong region.
        sendError(socket, ERROR_CODES.ALREADY_READY, "already authenticated");
        break;
      case "heartbeat":
        onHeartbeat();
        break;
      case "accept":
        // Nothing to do. `accept` exists so a probe can say it has the work
        // before a long check produces anything, which is useful in a log and
        // will matter to the pull-based successor's lease. The server's own
        // timeout is what actually decides, so acting on this would only add a
        // second clock.
        break;
      case "reject":
        onReject(message.id, typeof message.reason === "string" ? message.reason : "no reason given");
        break;
      case "result":
        await onResult(message);
        break;
      case "bye":
        close(1000, "bye");
        break;
      case "error":
        console.warn(`Probe agent ${connection.agent.id} reported an error: ${message.code} ${message.message}`);
        break;
      default:
        sendError(socket, ERROR_CODES.BAD_MESSAGE, `server does not handle "${message.type}"`);
    }
  }

  async function onHello(message: Extract<ProbeMessage, { type: "hello" }>): Promise<void> {
    const auth = await authenticateProbe(message.token);
    if (!auth.ok) {
      // The probe is told only that it was refused. Distinguishing "unknown
      // token" from "that agent is disabled" would let a stranger learn which
      // tokens exist by trying them.
      console.warn(`Probe connection refused: ${auth.reason}`);
      sendError(socket, ERROR_CODES.UNAUTHORIZED, "probe token was not accepted");
      close(1008, "unauthorized");
      return;
    }

    const agent = auth.agent;
    const registered = registry.register(
      agent,
      (frame) => {
        try {
          socket.send(frame);
        } catch (error) {
          console.error(`Could not write to probe agent ${agent.id}:`, error);
        }
      },
      close,
    );

    if (!registered.ok) {
      sendError(socket, registered.code, registered.reason);
      close(1008, registered.reason);
      return;
    }

    clearTimeout(helloTimer);
    connection = registered.connection;

    const capabilities = Array.isArray(message.capabilities) ? JSON.stringify(message.capabilities) : null;
    const agentVersion = typeof message.agent_version === "string" ? message.agent_version : null;
    // The registry's copy of the agent is what `planProbeExecution` intersects
    // against, so it has to carry what this connection reported rather than what
    // the row held when the token was looked up.
    connection.agent = { ...agent, capabilities, agent_version: agentVersion };

    const seenAt = nowSeconds();
    lastSeenWrittenAt = seenAt;
    await recordConnectionState(agent, {
      connection_state: "CONNECTED",
      last_seen_at: seenAt,
      agent_version: agentVersion,
      capabilities,
    });

    socket.send(
      encode({
        type: "ready",
        id: message.id,
        agent_id: agent.id,
        region_id: agent.region_id,
        heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
      }),
    );

    console.log(`Probe agent ${agent.id} (${agent.name}) connected for region ${agent.region_id}`);
    await emitProbeEvent(agent, "probe.connected", { agent_version: agentVersion });
  }

  function onHeartbeat(): void {
    if (!connection) return;
    registry.noteHeartbeat(connection.agent.id);

    const seenAt = nowSeconds();
    if (seenAt - lastSeenWrittenAt < LAST_SEEN_WRITE_INTERVAL_SECONDS) return;
    lastSeenWrittenAt = seenAt;
    void recordConnectionState(connection.agent, { connection_state: "CONNECTED", last_seen_at: seenAt });
  }

  function onReject(id: string, reason: string): void {
    if (!connection) return;
    const pending = connection.pending.get(id);
    if (!pending) return;
    connection.pending.delete(id);
    pending.resolve({ kind: "reject", reason });
  }

  async function onResult(message: ResultMessage): Promise<void> {
    if (!connection) return;
    const agent = connection.agent;

    const pending = connection.pending.get(message.id);
    if (!pending) {
      // Either the assignment already timed out and the check was run locally,
      // or the probe invented a correlation id. Both are dropped: writing it
      // would either duplicate a sample the server has already produced or let a
      // probe write one it was never asked for.
      console.warn(`Probe agent ${agent.id} sent a result for unknown assignment ${message.id}`);
      void emitProbeEvent(agent, "probe.result_late", {
        monitor_tag: typeof message.monitor_tag === "string" ? message.monitor_tag : null,
        assignment_id: message.id,
      });
      return;
    }

    connection.pending.delete(message.id);

    // The frame's own tag and minute are checked against the assignment rather
    // than used. They agree for any honest probe; when they do not, the result
    // is discarded rather than written somewhere the server did not choose.
    if (message.monitor_tag !== pending.monitor_tag || Number(message.ts) !== pending.ts) {
      console.warn(
        `Probe agent ${agent.id} answered assignment ${message.id} with ${message.monitor_tag}@${message.ts}, expected ${pending.monitor_tag}@${pending.ts}`,
      );
      pending.resolve({ kind: "gone", reason: "the probe answered a different assignment" });
      return;
    }

    const result = normaliseResult(message.result);
    if (!result) {
      console.warn(`Probe agent ${agent.id} sent an unusable result for ${pending.monitor_tag}`);
      pending.resolve({ kind: "gone", reason: "the probe sent an unusable result" });
      return;
    }

    // A region >= 1 agent contributes a sample and nothing else, so its result
    // goes straight to the response queue at its own region. A region-0 agent's
    // result is the verdict, and it is handed back to the execute worker that is
    // waiting for it so that overlays, the confirmation threshold and the merge
    // all still apply exactly as they do to a local check.
    if (agent.region_id !== MERGED_REGION_ID) {
      try {
        await runWithOrg(agent.org_id, () =>
          monitorResponseQueue.push(pending.monitor_tag, pending.ts, result, agent.region_id),
        );
      } catch (error) {
        console.error(`Could not enqueue probe result for ${pending.monitor_tag}:`, error);
      }
    }

    pending.resolve({ kind: "result", result });
  }
}

/**
 * Narrows what arrived on the wire to a `MonitoringResult`.
 *
 * A probe is somebody else's process on somebody else's hardware, so its result
 * is validated rather than cast. `status` and `type` are the two the storage
 * path indexes and renders on; a missing latency is zero, which is what a local
 * check records for a status it did not time.
 */
function normaliseResult(raw: unknown): MonitoringResult | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.status !== "string" || value.status.length === 0) return null;
  if (typeof value.type !== "string" || value.type.length === 0) return null;

  const latency = Number(value.latency);
  const result: MonitoringResult = {
    status: value.status,
    latency: Number.isFinite(latency) && latency >= 0 ? latency : 0,
    type: value.type,
  };
  if (typeof value.error_message === "string") result.error_message = value.error_message;
  if (typeof value.raw_status === "string") result.raw_status = value.raw_status;
  return result;
}
