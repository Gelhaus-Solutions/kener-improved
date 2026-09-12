import WebSocket from "ws";
import ApiCall from "../../src/lib/server/services/apiCall.js";
import PingCall from "../../src/lib/server/services/pingCall.js";
import TcpCall from "../../src/lib/server/services/tcpCall.js";
import DnsCall from "../../src/lib/server/services/dnsCall.js";
import SSLCall from "../../src/lib/server/services/sslCall.js";
import {
  ERROR_CODES,
  PROTOCOL_VERSION,
  encode,
  newMessageId,
  parseMessage,
  type AssignMessage,
  type ReadyMessage,
} from "../../src/lib/server/probes/protocol.js";
import type {
  ApiMonitor,
  DnsMonitor,
  MonitoringResult,
  PingMonitor,
  SslMonitor,
  TcpMonitor,
} from "../../src/lib/server/types/monitor.js";

/**
 * The Kener remote probe (B1c).
 *
 * A small daemon that connects to a Kener instance, is told which checks to run,
 * runs them, and reports the results back. It holds no database, no Redis and no
 * Kener secrets: everything it needs to make a check arrives in the `assign`
 * frame, with `$SECRET` tokens already resolved by the server.
 *
 * **It reuses Kener's own service classes, unchanged.** `apiCall`, `pingCall`,
 * `tcpCall`, `dnsCall` and `sslCall` each take `(monitor, timestamp)`, open one
 * socket and touch no database, which is exactly what makes them safe to run
 * somewhere else - and reusing them is what makes a remote check produce the
 * same verdict as a local one rather than a second implementation's opinion.
 * The build bundles them from `../src`, so there is one copy of the logic.
 *
 * **It is a client, not a server.** It opens the connection outwards, so a probe
 * can live behind NAT with no inbound firewall rule, which is most of the point
 * of putting one in another network.
 */

const WS_URL = process.env.KENER_PROBE_URL;
/**
 * The tokens this probe presents, one session each.
 *
 * **One container, several organisations.** A probe agent belongs to exactly one
 * org, so monitoring three tenants from one box used to mean three containers.
 * Each token here opens its own session to the same upstream and authenticates
 * as that org's agent; the server needs no change at all, because its registry
 * is keyed by `org:region` and by agent id, so two agents in different orgs are
 * already independent sessions even when they share a region id and a host.
 *
 * Still one upstream: `KENER_PROBE_URL` is singular and stays that way. A probe
 * that fanned out to several Kener servers would have two sources of truth for
 * what it should be checking.
 *
 * Comma-separated in the singular variable rather than a new plural one, so a
 * single-token deployment, every existing compose file and the README are
 * untouched: one token is a list of one. Whitespace and empty entries are
 * dropped, which is what makes a multi-line value from a secret manager or a
 * YAML block scalar behave. Duplicates are dropped too - the same token twice
 * would open two sessions as the same agent, and the server closes the first as
 * "replaced by a newer connection" in a loop.
 */
function parseTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const token of raw.split(/[,\s]+/)) {
    const trimmed = token.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

const TOKENS = parseTokens(process.env.KENER_PROBE_TOKEN);
/**
 * Injected from `probe/package.json` at bundle time, overridable at runtime.
 *
 * Declared rather than imported so the bundle carries a literal: reading the
 * package at runtime would need a file the image deliberately does not ship.
 */
declare const __KENER_PROBE_VERSION__: string;
const BUILT_VERSION = typeof __KENER_PROBE_VERSION__ === "string" ? __KENER_PROBE_VERSION__ : "0.0.0-dev";
const AGENT_VERSION = process.env.KENER_PROBE_VERSION ?? BUILT_VERSION;

/**
 * Per-check logging, off by default.
 *
 * A probe handed a hundred monitors on a one-minute cron would otherwise print a
 * hundred lines a minute to say that everything is normal. But the first thing
 * anybody wants when setting a probe up is proof that it is actually running the
 * checks rather than merely holding a connection, and that is exactly what this
 * shows. On for the first ten minutes, off afterwards.
 */
const DEBUG = process.env.KENER_PROBE_DEBUG === "1" || process.env.KENER_PROBE_DEBUG === "true";

/** What this build can actually run. The server intersects it with its own list. */
const CAPABILITIES = ["API", "PING", "TCP", "DNS", "SSL"];

/** Reconnect backoff, in milliseconds. Capped so a long outage does not become a long silence after it ends. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

if (!WS_URL || TOKENS.length === 0) {
  console.error("KENER_PROBE_URL and KENER_PROBE_TOKEN are both required");
  console.error("KENER_PROBE_TOKEN may be a comma-separated list, one token per organisation.");
  process.exit(1);
}

/** Set once, by a signal. Every session checks it before reconnecting. */
let shuttingDown = false;

/**
 * Runs one assigned check.
 *
 * Returns null for a type this build does not implement, which the caller turns
 * into a `reject`. That is not an error: the server simply runs the check itself,
 * which is what it would have done had the probe never connected.
 */
async function runCheck(assignment: AssignMessage): Promise<MonitoringResult | null> {
  const monitor = {
    tag: assignment.monitor_tag,
    monitor_type: assignment.monitor_type,
    type_data: assignment.type_data,
  };

  switch (assignment.monitor_type) {
    case "API":
      return await new ApiCall(monitor as ApiMonitor).execute(assignment.ts);
    case "PING":
      return await new PingCall(monitor as PingMonitor).execute(assignment.ts);
    case "TCP":
      return await new TcpCall(monitor as TcpMonitor).execute(assignment.ts);
    case "DNS":
      return await new DnsCall(monitor as DnsMonitor).execute(assignment.ts);
    case "SSL":
      return await new SSLCall(monitor as SslMonitor).execute(assignment.ts);
    default:
      return null;
  }
}

/**
 * One authenticated session: one token, one socket, its own backoff.
 *
 * **Everything that was module-level state is per session now**, and that is the
 * whole correctness argument for multi-org. `send` used to write to the single
 * global socket; with several sessions open, a result written to the wrong
 * socket would be a result delivered to the wrong organisation. Closing over the
 * socket makes that impossible to express rather than merely unlikely: there is
 * no way to reach another session's socket from inside this one.
 */
function createSession(token: string) {
  let socket: WebSocket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  /** Set when the server refuses this token. Refused sessions never retry. */
  let refused = false;

  // Until `ready` arrives all this session can be called is the last four
  // characters of its token, which is the same hint the probes screen shows
  // beside the agent. Afterwards it is named by the agent it authenticated as,
  // so every later line is attributable to one organisation's agent.
  let label = `token \u2026${token.slice(-4)}`;

  function log(message: string): void {
    console.log(`[${label}] ${message}`);
  }
  function warn(message: string): void {
    console.warn(`[${label}] ${message}`);
  }
  function error(message: string): void {
    console.error(`[${label}] ${message}`);
  }

  function send(frame: string): void {
    if (socket?.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(frame);
    } catch (err) {
      error(`Could not write to Kener: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function startHeartbeat(intervalSeconds: number): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      send(encode({ type: "heartbeat", id: newMessageId("h") }));
    }, intervalSeconds * 1000);
  }

  function stopHeartbeat(): void {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  async function onAssign(assignment: AssignMessage): Promise<void> {
    // Sent before the check runs, not after. A check can take as long as its
    // timeout allows, and the server's log is much easier to read when it says
    // the probe took the work rather than going silent for ten seconds.
    send(encode({ type: "accept", id: assignment.id, monitor_tag: assignment.monitor_tag, ts: assignment.ts }));

    let result: MonitoringResult | null = null;
    try {
      result = await runCheck(assignment);
    } catch (err) {
      // A service class throwing is a bug or an environment fault, not a DOWN
      // verdict. Rejecting hands the check back to Kener, which will run it
      // locally and get an answer; inventing a DOWN here would put a fabricated
      // outage on somebody's status page.
      const message = err instanceof Error ? err.message : String(err);
      error(`Check for ${assignment.monitor_tag} threw: ${message}`);
      send(
        encode({
          type: "reject",
          id: assignment.id,
          monitor_tag: assignment.monitor_tag,
          ts: assignment.ts,
          reason: `check threw: ${message}`,
        }),
      );
      return;
    }

    if (!result) {
      send(
        encode({
          type: "reject",
          id: assignment.id,
          monitor_tag: assignment.monitor_tag,
          ts: assignment.ts,
          reason: `this probe does not run ${assignment.monitor_type} checks`,
        }),
      );
      return;
    }

    if (DEBUG) {
      log(
        `ran ${assignment.monitor_type} ${assignment.monitor_tag} @${assignment.ts}: ${result.status} in ${result.latency}ms`,
      );
    }

    send(
      encode({
        type: "result",
        id: assignment.id,
        monitor_tag: assignment.monitor_tag,
        ts: assignment.ts,
        result,
      }),
    );
  }

  function connect(): void {
    if (shuttingDown || refused) return;

    log(`Connecting to ${WS_URL}`);
    socket = new WebSocket(WS_URL as string);

    socket.on("open", () => {
      send(
        encode({
          type: "hello",
          id: newMessageId("hello"),
          token,
          agent_version: AGENT_VERSION,
          capabilities: CAPABILITIES,
        }),
      );
    });

    socket.on("message", (raw: unknown) => {
      const parsed = parseMessage(String(raw));
      if (!parsed.ok) {
        error(`Kener sent something unreadable: ${parsed.reason}`);
        return;
      }

      const message = parsed.message;
      switch (message.type) {
        case "ready": {
          const ready = message as ReadyMessage;
          // The server owns the cadence, so the probe's timer and the server's
          // patience can never drift apart into a fleet that marks itself offline.
          label = `agent ${ready.agent_id}`;
          log(`Connected, region ${ready.region_id}`);
          reconnectDelay = RECONNECT_MIN_MS;
          startHeartbeat(ready.heartbeat_interval_seconds);
          break;
        }
        case "assign":
          // Not awaited: a slow check must not stop the probe reading its socket,
          // or a single ten-second API monitor would block every other assignment
          // and the heartbeat with it.
          void onAssign(message as AssignMessage).catch((err) => {
            error(`Assignment handling failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          break;
        case "bye":
          log("Kener closed the session");
          break;
        case "error":
          error(`Kener refused: ${message.code} ${message.message}`);
          // An authentication failure will fail identically on every retry, so a
          // reconnect loop would be a pointless one.
          //
          // **It takes down this session only.** With one container serving
          // several organisations, one revoked token must not stop the others
          // being monitored - and the container exits only when every session has
          // been refused, so a wholly broken configuration still fails fast and
          // visibly rather than idling forever.
          if (message.code === ERROR_CODES.UNAUTHORIZED || message.code === ERROR_CODES.BAD_VERSION) {
            refused = true;
            stopHeartbeat();
            socket?.close(1000, "refused");
            exitIfAllRefused();
          }
          break;
        default:
          break;
      }
    });

    socket.on("close", () => {
      stopHeartbeat();
      socket = null;
      if (shuttingDown || refused) return;

      warn(`Disconnected, retrying in ${Math.round(reconnectDelay / 1000)}s`);
      setTimeout(connect, reconnectDelay);
      // Exponential up to the cap. Kener falls back to checking locally while the
      // probe is away, so retrying hard buys nothing and a restarting server
      // should not be met with a reconnect storm from every agent at once.
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    });

    socket.on("error", (err: Error) => {
      // `ws` emits error then close, and close is what schedules the retry.
      error(`Socket error: ${err.message}`);
    });
  }

  function farewell(signal: string): void {
    stopHeartbeat();
    // Saying goodbye is worth the extra frame: it lets Kener drop the agent from
    // its registry at once and fall back to local checks immediately, rather than
    // waiting out three missed heartbeats first.
    send(encode({ type: "bye", id: newMessageId("bye"), reason: signal }));
    socket?.close(1000, "shutting down");
  }

  return {
    connect,
    farewell,
    get refused() {
      return refused;
    },
  };
}

const sessions = TOKENS.map(createSession);

/**
 * Exits non-zero once every session has been refused.
 *
 * One refused token among several is a configuration problem for one
 * organisation and is logged as such; all of them refused is a container that
 * can never do anything, and staying up would bury that in a log nobody reads.
 * `process.exitCode` rather than `process.exit` so the remaining sockets close
 * cleanly first.
 */
function exitIfAllRefused(): void {
  if (!sessions.every((session) => session.refused)) return;
  console.error("Every token was refused; nothing left to do");
  shuttingDown = true;
  process.exitCode = 1;
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, disconnecting ${sessions.length} session(s)`);
  for (const session of sessions) session.farewell(signal);
  // A short grace period for the close frames to leave, then go regardless.
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log(
  `Kener probe ${AGENT_VERSION}, protocol v${PROTOCOL_VERSION}, capabilities ${CAPABILITIES.join(", ")}, ` +
    `${sessions.length} session(s)`,
);
for (const session of sessions) session.connect();
