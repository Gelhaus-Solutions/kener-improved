import type { MonitoringResult } from "../types/monitor.js";

/**
 * The probe wire protocol (B1c).
 *
 * JSON text frames, one message per frame. Every message carries the same
 * envelope, and the nine types below are the whole vocabulary.
 *
 * **This module is shared with the standalone probe.** `probe/` esbuilds an
 * entry that imports this file by relative path, so the daemon and the server
 * are compiled from one definition of the protocol rather than two that agree by
 * inspection. It therefore imports nothing but types: pulling in `db`, `q` or
 * anything else server-side here would drag Knex and BullMQ into the probe's
 * bundle, which is the whole thing the split is trying to avoid.
 *
 * **The envelope is the part to keep.** B1c's transport is explicitly
 * throwaway - push-based assignment, an in-process registry, one agent per
 * region - but `{v, type, id}` is what a pull-based, multi-instance successor
 * would still speak, so it is worth getting right now.
 *
 *   `v`     protocol version. Bumped when a change is not backward compatible;
 *           a server that sees a version it does not know rejects the connection
 *           rather than guessing at the frame.
 *   `type`  which of the nine.
 *   `id`    correlation id, chosen by whoever starts an exchange. `accept`,
 *           `reject` and `result` all echo the `assign` they answer, which is
 *           what lets the server match a result to the check it asked for
 *           without relying on ordering.
 */

export const PROTOCOL_VERSION = 1;

/** Every message type in the protocol. The order is the order a session uses them. */
export const MESSAGE_TYPES = [
  // Probe -> server. First frame on every connection; carries the token.
  "hello",
  // Server -> probe. Authentication succeeded; the probe may now be assigned work.
  "ready",
  // Server -> probe. Run this check.
  "assign",
  // Probe -> server. Taking it.
  "accept",
  // Probe -> server. Not taking it, with a reason. An unsupported monitor type
  // is the ordinary case and is not an error: the server simply runs it locally.
  "reject",
  // Probe -> server. The check finished; carries a `MonitoringResult`.
  "result",
  // Probe -> server. Still alive. Distinct from the WS ping/pong control frames,
  // which prove the *socket* is open; this proves the probe's own loop is
  // running, which is what the sweeper acts on.
  "heartbeat",
  // Either direction. Closing deliberately, so the peer need not wait for a
  // timeout to find out.
  "bye",
  // Either direction. Something was wrong with the exchange itself.
  "error",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface Envelope {
  v: number;
  type: MessageType;
  id: string;
}

/**
 * Probe -> server. The first frame, and the only one accepted before auth.
 *
 * `capabilities` is what this build can actually run. The server intersects it
 * with `PROBE_ELIGIBLE_TYPES` rather than trusting either side alone, so an old
 * agent is never handed a check it does not implement and a lying agent is never
 * handed one the server forbids.
 */
export interface HelloMessage extends Envelope {
  type: "hello";
  token: string;
  agent_version: string;
  capabilities: string[];
}

/**
 * Server -> probe. Authenticated.
 *
 * `heartbeat_interval_seconds` is the server telling the probe how often to
 * speak, so the cadence lives in one place: the sweeper's patience and the
 * probe's timer can never drift apart into a fleet that marks itself offline.
 */
export interface ReadyMessage extends Envelope {
  type: "ready";
  agent_id: number;
  region_id: number;
  heartbeat_interval_seconds: number;
}

/**
 * Server -> probe. Run this check.
 *
 * `type_data` arrives **secret-resolved**: `GetRequiredSecrets` and
 * `ReplaceAllOccurrences` have already run server-side, so the probe never holds
 * Kener's environment but does see the credentials for the monitors assigned to
 * it. That trade is stated in B1c and the mitigation (per-monitor secret
 * scoping) is later work.
 *
 * `ts` is the minute-start the result will be stored at. The probe echoes it
 * back rather than taking its own clock's word for the minute, because two
 * machines disagreeing by a second would otherwise write two rows.
 */
export interface AssignMessage extends Envelope {
  type: "assign";
  monitor_tag: string;
  monitor_type: string;
  type_data: unknown;
  ts: number;
  /** How long the probe should allow before giving up, in milliseconds. */
  timeout_ms: number;
}

export interface AcceptMessage extends Envelope {
  type: "accept";
  monitor_tag: string;
  ts: number;
}

export interface RejectMessage extends Envelope {
  type: "reject";
  monitor_tag: string;
  ts: number;
  reason: string;
}

export interface ResultMessage extends Envelope {
  type: "result";
  monitor_tag: string;
  ts: number;
  result: MonitoringResult;
}

export interface HeartbeatMessage extends Envelope {
  type: "heartbeat";
}

export interface ByeMessage extends Envelope {
  type: "bye";
  reason?: string;
}

export interface ErrorMessage extends Envelope {
  type: "error";
  code: string;
  message: string;
}

export type ProbeMessage =
  | HelloMessage
  | ReadyMessage
  | AssignMessage
  | AcceptMessage
  | RejectMessage
  | ResultMessage
  | HeartbeatMessage
  | ByeMessage
  | ErrorMessage;

/** Error codes carried by `error`, so a probe can branch on them without parsing prose. */
export const ERROR_CODES = {
  /** The frame was not JSON, or not a message this protocol defines. */
  BAD_MESSAGE: "BAD_MESSAGE",
  /** `v` is a protocol version this server does not speak. */
  BAD_VERSION: "BAD_VERSION",
  /** The token was absent, unknown, or belongs to a disabled agent. */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** A frame other than `hello` arrived before authentication. */
  NOT_READY: "NOT_READY",
  /** A second `hello` on an already-authenticated connection. */
  ALREADY_READY: "ALREADY_READY",
  /**
   * No longer sent. B1c allowed one agent per region and refused the second with
   * this; a region may now hold any number. Kept because it is part of the v1
   * wire contract and a deployed probe still has a branch for it, so removing it
   * would be a protocol change for no gain.
   */
  REGION_TAKEN: "REGION_TAKEN",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

let counter = 0;

/**
 * A correlation id.
 *
 * Not a UUID and deliberately not crypto-random: an id only has to be unique
 * within one connection's lifetime, it is never a secret, and the probe bundle
 * should not gain a dependency to produce one. The counter makes collisions
 * impossible within a process and the timestamp keeps ids from repeating across
 * a restart, which is all the uniqueness this needs.
 */
export function newMessageId(prefix = "m"): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses one frame into a message, or explains why it is not one.
 *
 * Returns a discriminated result rather than throwing, because every caller is a
 * socket handler that has to answer with an `error` frame instead of letting the
 * failure escape: a malformed frame from somebody else's daemon is an ordinary
 * event, not an exception.
 *
 * This validates the **envelope** and nothing more. Per-type field checks live
 * with the handler that acts on the message, where the context to reject
 * sensibly (and the agent to blame) is actually in hand.
 */
export function parseMessage(
  raw: string,
): { ok: true; message: ProbeMessage } | { ok: false; code: ErrorCode; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: ERROR_CODES.BAD_MESSAGE, reason: "frame is not valid JSON" };
  }

  if (!isRecord(parsed)) {
    return { ok: false, code: ERROR_CODES.BAD_MESSAGE, reason: "frame is not an object" };
  }

  const { v, type, id } = parsed;

  if (typeof v !== "number") {
    return { ok: false, code: ERROR_CODES.BAD_MESSAGE, reason: "v is required and must be a number" };
  }
  // Checked before `type`, so a future protocol's unknown message type is
  // reported as the version mismatch it actually is rather than as a bad frame.
  if (v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: ERROR_CODES.BAD_VERSION,
      reason: `this server speaks protocol v${PROTOCOL_VERSION}, got v${v}`,
    };
  }
  if (typeof type !== "string" || !(MESSAGE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, code: ERROR_CODES.BAD_MESSAGE, reason: `unknown message type "${String(type)}"` };
  }
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, code: ERROR_CODES.BAD_MESSAGE, reason: "id is required and must be a non-empty string" };
  }

  return { ok: true, message: parsed as unknown as ProbeMessage };
}

/**
 * A message with `v` made optional, one variant at a time.
 *
 * Distributive on purpose. A bare `Omit<ProbeMessage, "v">` over a union keeps
 * only the keys every variant shares, so it would accept `{type: "ready"}` with
 * no `agent_id` and reject the `code` on an `error` - exactly backwards. The
 * conditional makes TypeScript apply the omit to each variant and re-union the
 * results, which preserves the discrimination on `type`.
 */
type Unversioned<T> = T extends ProbeMessage ? Omit<T, "v"> & { v?: number } : never;

/** Serialises a message, filling in the version so no call site can forget it. */
export function encode(message: Unversioned<ProbeMessage>): string {
  return JSON.stringify({ ...message, v: PROTOCOL_VERSION });
}
