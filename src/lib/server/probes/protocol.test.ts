import { describe, it, expect } from "vitest";
import { ERROR_CODES, PROTOCOL_VERSION, encode, newMessageId, parseMessage } from "./protocol.js";

describe("parseMessage", () => {
  const good = { v: PROTOCOL_VERSION, type: "heartbeat", id: "h-1" };

  it("accepts a well-formed envelope", () => {
    const parsed = parseMessage(JSON.stringify(good));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message.type).toBe("heartbeat");
  });

  it("refuses a frame that is not JSON", () => {
    const parsed = parseMessage("not json");
    expect(parsed).toMatchObject({ ok: false, code: ERROR_CODES.BAD_MESSAGE });
  });

  it("refuses a frame that is JSON but not an object", () => {
    // A bare array passes JSON.parse and would otherwise reach the property
    // reads below, where every field would be undefined.
    expect(parseMessage("[1,2,3]")).toMatchObject({ ok: false, code: ERROR_CODES.BAD_MESSAGE });
    expect(parseMessage('"hello"')).toMatchObject({ ok: false, code: ERROR_CODES.BAD_MESSAGE });
  });

  it("reports a version mismatch as BAD_VERSION, not as a bad frame", () => {
    // The distinction is what lets a probe tell "you are too old" from "you sent
    // rubbish", and it is why the version is checked before the type.
    const parsed = parseMessage(JSON.stringify({ ...good, v: PROTOCOL_VERSION + 1 }));
    expect(parsed).toMatchObject({ ok: false, code: ERROR_CODES.BAD_VERSION });
  });

  it("reports an unknown type from a FUTURE version as the version problem", () => {
    // The ordering that matters: a v2 message type would otherwise be reported
    // as "unknown message type", sending whoever reads the log hunting for a
    // typo instead of upgrading.
    const parsed = parseMessage(JSON.stringify({ v: 99, type: "lease", id: "x" }));
    expect(parsed).toMatchObject({ ok: false, code: ERROR_CODES.BAD_VERSION });
  });

  it("refuses an unknown type at the current version", () => {
    const parsed = parseMessage(JSON.stringify({ ...good, type: "nonsense" }));
    expect(parsed).toMatchObject({ ok: false, code: ERROR_CODES.BAD_MESSAGE });
  });

  it("refuses a missing or non-string id", () => {
    expect(parseMessage(JSON.stringify({ v: PROTOCOL_VERSION, type: "heartbeat" }))).toMatchObject({ ok: false });
    expect(parseMessage(JSON.stringify({ ...good, id: 7 }))).toMatchObject({ ok: false });
    expect(parseMessage(JSON.stringify({ ...good, id: "" }))).toMatchObject({ ok: false });
  });

  it("refuses a missing version rather than assuming the current one", () => {
    // Assuming would mean a peer that never declared a version is treated as
    // speaking this one, which is exactly the compatibility bug the field exists
    // to prevent.
    expect(parseMessage(JSON.stringify({ type: "heartbeat", id: "h-1" }))).toMatchObject({ ok: false });
  });
});

describe("encode", () => {
  it("fills in the protocol version so no call site can forget it", () => {
    const frame = encode({ type: "heartbeat", id: "h-1" });
    expect(JSON.parse(frame)).toEqual({ v: PROTOCOL_VERSION, type: "heartbeat", id: "h-1" });
  });

  it("round-trips every field of a richer message", () => {
    const frame = encode({
      type: "result",
      id: "a-1",
      monitor_tag: "api",
      ts: 1700000000,
      result: { status: "UP", latency: 12, type: "REALTIME" },
    });
    const parsed = parseMessage(frame);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === "result") {
      expect(parsed.message.monitor_tag).toBe("api");
      expect(parsed.message.result.latency).toBe(12);
    }
  });
});

describe("newMessageId", () => {
  it("does not repeat within a process", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newMessageId()));
    expect(ids.size).toBe(5000);
  });
});
