import db from "../db/db.js";
import { runWithOrg } from "../db/orgContext.js";
import * as registry from "./registry.js";
import { emitProbeEvent, HEARTBEAT_INTERVAL_SECONDS, MISSED_HEARTBEATS_BEFORE_OFFLINE } from "./session.js";

/**
 * Reaps probes that have stopped speaking (B1c).
 *
 * **Why an application heartbeat when WS already has ping/pong.** They prove
 * different things. A pong is answered by the `ws` library itself, so it proves
 * the socket is open and the peer's event loop is turning - which a probe stuck
 * in a pathological check, or one whose own scheduler has died, would still
 * manage. The `heartbeat` frame is sent by the probe's own loop, so it proves
 * the part that would actually run a check is alive. A probe that pongs but does
 * not heartbeat is exactly the case worth catching, because it is the one that
 * would otherwise be handed work forever and silently never do it.
 *
 * Three missed intervals - 90 seconds - then the connection is dropped and the
 * agent is marked OFFLINE. Dropping it is what matters: `planProbeExecution`
 * asks the registry, so from that moment the monitor is checked locally again,
 * which is the fallback the whole design turns on.
 */

let timer: NodeJS.Timeout | null = null;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * One pass over the connected fleet.
 *
 * Exported for the tests, which drive it directly rather than waiting 90 seconds
 * of wall clock for the interval to fire three times.
 */
export async function sweepOnce(): Promise<void> {
  const now = nowSeconds();

  for (const connection of registry.allConnections()) {
    const silentFor = now - connection.lastHeartbeatAt;
    // Derived from elapsed time rather than counted per tick, so a sweep that
    // was itself delayed (a busy event loop, a suspended laptop) does not
    // under-count the silence and keep a dead probe alive.
    const missed = Math.floor(silentFor / HEARTBEAT_INTERVAL_SECONDS);
    connection.missedHeartbeats = missed;

    if (missed < MISSED_HEARTBEATS_BEFORE_OFFLINE) continue;

    const agent = connection.agent;
    console.warn(
      `Probe agent ${agent.id} (${agent.name}) has been silent for ${silentFor}s, marking offline and checking locally`,
    );

    // Unregister before closing. The close handler in `session.ts` checks
    // whether it is still the registered connection precisely so that this
    // sequence records OFFLINE once, rather than having the close it triggers
    // overwrite it with DISCONNECTED.
    registry.unregister(agent.id, "the probe stopped sending heartbeats");
    connection.close(1001, "no heartbeat");

    try {
      await runWithOrg(agent.org_id, () =>
        db.setProbeAgentConnection(agent.id, {
          connection_state: "OFFLINE",
          last_seen_at: connection.lastHeartbeatAt,
        }),
      );
    } catch (error) {
      console.error(`Could not mark probe agent ${agent.id} offline:`, error);
    }

    // Both events, in this order, because they say different things: the socket
    // has gone, and the agent is now considered unavailable. A consumer that
    // pages on `probe.offline` wants the second without having to infer it from
    // the first, and one keeping a connection log wants the first.
    await emitProbeEvent(agent, "probe.disconnected", { cause: "no_heartbeat", silent_for_seconds: silentFor });
    await emitProbeEvent(agent, "probe.offline", { silent_for_seconds: silentFor });
  }
}

export function start(): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweepOnce().catch((error) => {
      // A failed sweep must never stop the interval: the next one would be the
      // thing that noticed a dead probe, and a fleet with no sweeper looks
      // healthy forever.
      console.error("Probe heartbeat sweep failed:", error);
    });
  }, HEARTBEAT_INTERVAL_SECONDS * 1000);
  // The sweeper must not hold the process open by itself. Shutdown stops it
  // explicitly; this makes a missed stop harmless rather than a hang.
  timer.unref?.();
}

export function stop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export default { start, stop, sweepOnce };
