import { describe, it, expect, beforeAll } from "vitest";
import jwt from "jsonwebtoken";
import { readSessionToken } from "./sessionController.js";

// What the session cookie is allowed to be.
//
// Every token this codebase issues is signed with the same key: invitations,
// email verification, password resets, subscriber links. So a valid signature
// proves only that *Kener* minted the thing, never that it minted it as a
// session. Without the `typ` check, a password-reset link pasted into the
// cookie would verify, and the only thing stopping it from being honoured would
// be that the session lookup happened to fail afterwards. "Fails later for an
// unrelated reason" is not a security property.

const SECRET = "session-token-test-secret";

beforeAll(() => {
  process.env.KENER_SECRET_KEY = SECRET;
});

const sign = (payload: object, expiresIn: number | string = 3600) =>
  jwt.sign(payload, SECRET, { expiresIn } as jwt.SignOptions);

describe("session cookie payloads", () => {
  it("accepts a well-formed session token", () => {
    const token = sign({ typ: "session", sid: "abc123", uid: 7, epoch: 3 });
    expect(readSessionToken(token)).toEqual({ typ: "session", sid: "abc123", uid: 7, epoch: 3 });
  });

  it("rejects another kind of token signed with the same key", () => {
    // The shape a password-reset or invitation link carries.
    expect(readSessionToken(sign({ email: "someone@example.com", validTill: Date.now() + 1000 }))).toBeNull();
  });

  it("rejects a token that only claims to be a session", () => {
    expect(readSessionToken(sign({ typ: "reset", sid: "abc", uid: 1 }))).toBeNull();
  });

  it("rejects the old whole-user-record token", () => {
    // What the previous scheme put in this cookie, for a year at a time. It has
    // a valid signature, so only the payload check refuses it - which is what
    // makes the cutover clean rather than a compatibility branch.
    const legacy = sign({ id: 1, email: "admin@example.com", name: "Admin", role: "admin" }, "1y");
    expect(readSessionToken(legacy)).toBeNull();
  });

  it("rejects a token signed with a different key", () => {
    expect(readSessionToken(jwt.sign({ typ: "session", sid: "a", uid: 1 }, "not-the-key"))).toBeNull();
  });

  it("rejects an expired token", () => {
    expect(readSessionToken(sign({ typ: "session", sid: "a", uid: 1, epoch: 0 }, -10))).toBeNull();
  });

  it("rejects garbage and empty input without throwing", () => {
    for (const value of ["", "not.a.token", "a.b.c", "null"]) {
      expect(readSessionToken(value)).toBeNull();
    }
  });

  it("rejects a session id or user id of the wrong type", () => {
    expect(readSessionToken(sign({ typ: "session", sid: 5, uid: 1 }))).toBeNull();
    expect(readSessionToken(sign({ typ: "session", sid: "a", uid: "1" }))).toBeNull();
  });

  it("defaults a missing epoch to zero rather than refusing", () => {
    // Zero is the epoch every user starts at, so a token minted before the
    // column existed compares equal for a user who has never had a permission
    // change. It still has to match, so this widens nothing.
    expect(readSessionToken(sign({ typ: "session", sid: "a", uid: 1 }))?.epoch).toBe(0);
  });
});
