import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/db.js", () => ({ default: { exportStandbyPage: vi.fn() } }));

import { BearerToken, HandleStandbyExport, TokenMatches } from "./export.js";
import { EncodeCursor, type StandbyExportPage } from "./tables.js";

const KEYS = ["KENER_ROLE", "KENER_STANDBY_TOKEN"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

const page = { format: 1, generatedAt: 1, next: null } as unknown as StandbyExportPage;

function call(headers: Record<string, string> = {}, query = "") {
  const url = new URL(`https://primary.example/ext/standby/export${query}`);
  const build = vi.fn(async () => page);
  return { build, response: HandleStandbyExport(new Request(url, { headers }), url, build) };
}

beforeEach(() => {
  delete process.env.KENER_ROLE;
  process.env.KENER_STANDBY_TOKEN = "correct-horse-battery-staple";
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("the export endpoint's auth", () => {
  it("does not exist without KENER_STANDBY_TOKEN", async () => {
    delete process.env.KENER_STANDBY_TOKEN;
    const { build, response } = call({ authorization: "Bearer anything" });
    expect((await response).status).toBe(404);
    expect(build).not.toHaveBeenCalled();
  });

  it("does not exist on a standby", async () => {
    process.env.KENER_ROLE = "standby";
    const { build, response } = call({ authorization: "Bearer correct-horse-battery-staple" });
    expect((await response).status).toBe(404);
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses a request with no token", async () => {
    const { build, response } = call();
    const res = await response;
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses a wrong token, including one that only shares a prefix", async () => {
    for (const token of ["wrong", "correct-horse-battery-stapl", "correct-horse-battery-staple-and-more"]) {
      const { build, response } = call({ authorization: `Bearer ${token}` });
      expect((await response).status).toBe(401);
      expect(build).not.toHaveBeenCalled();
    }
  });

  it("answers the right token with the page, passing the cursor through", async () => {
    const after = EncodeCursor({ t: 1, k: [100, "api", 3600] });
    const { build, response } = call(
      { authorization: "Bearer correct-horse-battery-staple" },
      `?since=1700000000&after=${after}&images=abc123`,
    );
    const res = await response;
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(page);
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        since: 1700000000,
        after: { t: 1, k: [100, "api", 3600] },
        imagesFingerprint: "abc123",
      }),
    );
  });

  it("rejects a malformed cursor or since rather than guessing", async () => {
    const auth = { authorization: "Bearer correct-horse-battery-staple" };
    expect((await call(auth, "?since=yesterday").response).status).toBe(400);
    expect((await call(auth, "?after=not-a-cursor").response).status).toBe(400);
    expect((await call(auth, `?after=${EncodeCursor({ t: 99, k: null })}`).response).status).toBe(400);
  });
});

describe("token helpers", () => {
  it("reads only a well-formed bearer header", () => {
    expect(BearerToken("Bearer abc")).toBe("abc");
    expect(BearerToken("bearer abc")).toBe("abc");
    expect(BearerToken("Basic abc")).toBeNull();
    expect(BearerToken("Bearer a b")).toBeNull();
    expect(BearerToken(null)).toBeNull();
  });

  it("compares tokens of any length without throwing", () => {
    expect(TokenMatches("a", "a")).toBe(true);
    expect(TokenMatches("a", "ab")).toBe(false);
    expect(TokenMatches("", "a")).toBe(false);
    expect(TokenMatches(null, "a")).toBe(false);
  });
});
