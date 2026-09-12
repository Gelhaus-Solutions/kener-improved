import { WebSocketServer, type WebSocket } from "ws";

/**
 * The probe WebSocket server (B1c), foundation only.
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
 * **Deliberately no protocol yet.** The item that introduces the protocol says
 * to prove the server comes up under both `npm run dev` and `npm run start`
 * before building anything on top of it, because the process split is the part
 * most likely to bite. So this accepts a connection, answers WS ping/pong, and
 * closes cleanly on shutdown - and nothing else. Every message type in the
 * protocol lands on top of this once it is known to run in both places.
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
  });

  server.on("error", (error: Error) => {
    console.error("Probe WS server error:", error);
  });

  await new Promise<void>((resolve) => server!.once("listening", resolve));
  console.log(`Probe WS server listening on port ${port}`);
}

export async function shutdown(): Promise<void> {
  if (!server) return;
  const closing = server;
  server = null;

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
