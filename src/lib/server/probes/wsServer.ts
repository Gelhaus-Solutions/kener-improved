import { WebSocketServer, type WebSocket } from "ws";
import db from "../db/db.js";
import { runWithOrg } from "../db/orgContext.js";
import { handleConnection } from "./session.js";
import * as registry from "./registry.js";
import sweeper from "./sweeper.js";

/**
 * The probe WebSocket server (B1c).
 *
 * **Where this runs is the constraint that decided everything else about it.**
 * An assignment originates in the monitor-execute worker and a result has to
 * reach `monitorResponseQueue`, so the server must live in the process that
 * holds the BullMQ workers. In production `scripts/main.ts` runs everything in
 * one process, but `npm run dev` runs `vite dev` and `vite-node startup.ts` as
 * **two separate processes** and only the second has the workers. `startup.ts`
 * is the one module that runs in that process in both modes, so the server is
 * started from `Startup()`.
 *
 * That also rules out the two obvious alternatives: a SvelteKit route and a
 * `hooks.server.ts` upgrade handler both live in the web process, which in dev
 * is the half with no workers at all.
 *
 * **Its own port, and off by default.** `KENER_PROBE_WS_PORT` unset means no
 * listener, so an instance that has never heard of probes opens nothing new.
 *
 * **This file stays the transport and nothing else.** It opens the port, hands
 * each accepted socket to `session.ts` and closes everything down again. The
 * protocol, the authentication and the registry live beside it, so that the
 * pull-based successor - which replaces all three - can do so without touching
 * the part that was proven to come up in both processes.
 */

let server: WebSocketServer | null = null;
const sockets = new Set<WebSocket>();

/** The configured port, or null when probes are switched off. */
export function configuredPort(): number | null {
  const raw = process.env.KENER_PROBE_WS_PORT;
  if (!raw) return null;
  const port = Number(raw);
  // A misconfigured port is worth refusing loudly. Silently falling back to a
  // default would open a listener the operator did not ask for, on a port they
  // are not expecting, which is the opposite of what an off-by-default switch is
  // for.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`KENER_PROBE_WS_PORT must be a port number, got "${raw}"`);
  }
  return port;
}

export async function start(): Promise<void> {
  if (server) return;
  const port = configuredPort();
  if (port === null) return;

  server = new WebSocketServer({ port });

  server.on("connection", (socket: WebSocket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // An error on one probe's socket must never reach the process. A probe that
    // dies mid-frame is an ordinary event for a daemon that lives on somebody
    // else's hardware, and the fallback for a silent probe is a local check.
    socket.on("error", () => sockets.delete(socket));
    handleConnection(socket);
  });

  server.on("error", (error: Error) => {
    console.error("Probe WS server error:", error);
  });

  await new Promise<void>((resolve) => server!.once("listening", resolve));

  // `connection_state` describes a socket held by *this* process, so every row
  // claiming CONNECTED at startup is a claim left behind by a process that has
  // since died. Nothing else would ever retract it: the sweeper only inspects
  // agents it holds a connection for, and this process holds none yet.
  await resetStaleConnectionStates();

  sweeper.start();
  console.log(`Probe WS server listening on port ${port}`);
}

/**
 * Clears CONNECTED rows left by a previous process, in every org.
 *
 * Across orgs because startup has no tenant context and every org's fleet is
 * equally stale. A failure here is logged and swallowed: it would leave an
 * admin screen showing a probe as connected when it is not, which is worth
 * knowing about but is not a reason to refuse to start the server.
 */
async function resetStaleConnectionStates(): Promise<void> {
  try {
    for (const orgId of await db.getActiveOrgIds()) {
      await runWithOrg(orgId, () => db.resetProbeConnectionStates());
    }
  } catch (error) {
    console.error("Could not reset stale probe connection states:", error);
  }
}

export async function shutdown(): Promise<void> {
  if (!server) return;
  const closing = server;
  server = null;

  sweeper.stop();
  // Before the sockets close, so that every assignment still outstanding is
  // failed at once and any execute worker waiting on a probe falls straight
  // through to a local check instead of holding the shutdown open for the length
  // of a monitor timeout.
  registry.clear("the server is shutting down");

  // Close the sockets before the server. `WebSocketServer.close` waits for
  // clients to go away on their own, and a probe is a long-lived daemon with no
  // reason to notice a shutdown it was not told about - so without this the
  // process hangs until something times out.
  for (const socket of sockets) {
    try {
      socket.close(1001, "server shutting down");
    } catch {
      // Already gone. Nothing to do and nothing worth logging.
    }
  }
  sockets.clear();

  await new Promise<void>((resolve) => closing.close(() => resolve()));
}

/** How many probes are connected. Exported for the smoke check and, later, the admin screen. */
export function connectionCount(): number {
  return sockets.size;
}

export default { start, shutdown, configuredPort, connectionCount };
