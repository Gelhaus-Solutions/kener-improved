import { describe, it, expect, vi, beforeEach } from "vitest";
import { permissions } from "../../allPerms.js";
import { orgPermissions } from "../../orgPerms.js";

// Scoped API keys: the ceiling on what a key may be granted, and the four
// independent reasons authentication refuses one.
//
// Both halves fail quietly if they regress. A broken ceiling turns
// `api_keys.write` into a privilege-escalation permission, and a missed refusal
// leaves a credential working that somebody believes they turned off. Neither
// shows up in ordinary use.

process.env.KENER_SECRET_KEY = "test-secret-for-api-key-scopes";

type ApiKeyRow = Record<string, unknown>;

// The parameter types are spelled out because the assertions below read
// `mock.calls`, and a `vi.fn(async () => …)` infers a zero-argument signature
// that makes every `calls[n][0]` a type error.
const dbMock = {
  createNewApiKey: vi.fn(async (_data: ApiKeyRow): Promise<number[]> => [1]),
  getApiKeyByHashedKey: vi.fn(async (_hash: string): Promise<ApiKeyRow | undefined> => undefined),
  getApiKeyById: vi.fn(async (_id: number): Promise<ApiKeyRow | undefined> => undefined),
  retireApiKey: vi.fn(async (_id: number, _name: string, _expiresAt: number): Promise<number> => 1),
  revokeApiKey: vi.fn(async (_id: number, _now: number): Promise<number> => 1),
  touchApiKey: vi.fn(async (_id: number, _now: number, _ip: string | null, _stale: number): Promise<void> => undefined),
};

vi.mock("../db/db.js", () => ({ default: dbMock }));
vi.mock("../redisConnector.js", () => ({
  // Every test here goes down the "Redis said no" or "Redis threw" path; the
  // throttle itself is exercised against a real Redis by the scratch driver.
  redisConnection: () => ({ set: async () => null }),
}));

const { CreateNewAPIKey, RotateApiKey, AuthenticateAPIKey, VerifyAPIKey, ApiKeyHasScope } =
  await import("./apiController.js");

const ALL_PERMISSION_IDS = [...permissions, ...orgPermissions].map((p) => p.id);

/** An owner: holds everything, so the ceiling never binds. */
const owner = { userId: 1, permissions: new Set(ALL_PERMISSION_IDS) };
/** Someone who can mint keys but can only read monitors. */
const limited = { userId: 2, permissions: new Set(["api_keys.write", "monitors.read"]) };

/** The scopes column the last createNewApiKey call was given. */
function lastInsertedScopes(): string[] {
  const call = dbMock.createNewApiKey.mock.calls.at(-1);
  return JSON.parse((call![0] as { scopes: string }).scopes);
}

beforeEach(() => {
  for (const fn of Object.values(dbMock)) fn.mockClear();
  dbMock.createNewApiKey.mockResolvedValue([1]);
});

describe("minting a key", () => {
  it("stores the requested scopes", async () => {
    const result = await CreateNewAPIKey({ name: "reader", scopes: ["monitors.read"] }, owner);
    expect(result.scopes).toEqual(["monitors.read"]);
    expect(lastInsertedScopes()).toEqual(["monitors.read"]);
  });

  it("issues a key with the documented shape and a matching prefix", async () => {
    const result = await CreateNewAPIKey({ name: "shape", scopes: ["monitors.read"] }, owner);
    expect(result.apiKey).toMatch(/^kener_[0-9a-f]{64}$/);
    const inserted = dbMock.createNewApiKey.mock.calls.at(-1)![0] as { key_prefix: string };
    expect(result.apiKey.startsWith(inserted.key_prefix)).toBe(true);
    // Short enough to be useless to an attacker, long enough to identify a row.
    expect(inserted.key_prefix).toHaveLength("kener_".length + 6);
  });

  it("never stores the key itself", async () => {
    const result = await CreateNewAPIKey({ name: "secret", scopes: ["monitors.read"] }, owner);
    const inserted = dbMock.createNewApiKey.mock.calls.at(-1)![0];
    expect(JSON.stringify(inserted)).not.toContain(result.apiKey);
  });

  it("defaults to full access when no scopes are named at all", async () => {
    // The pre-scoping call shape. Keeping it working is what stops a seed or a
    // script from silently minting a key that can do nothing.
    await CreateNewAPIKey({ name: "legacy" });
    expect(lastInsertedScopes()).toEqual(["*"]);
  });

  it("collapses a wildcard mixed with named scopes", async () => {
    await CreateNewAPIKey({ name: "mixed", scopes: ["*", "monitors.read"] }, owner);
    expect(lastInsertedScopes()).toEqual(["*"]);
  });

  it("deduplicates", async () => {
    await CreateNewAPIKey({ name: "dupes", scopes: ["monitors.read", "monitors.read"] }, owner);
    expect(lastInsertedScopes()).toEqual(["monitors.read"]);
  });

  it("refuses an unknown scope rather than dropping it", async () => {
    // Dropping it would mint a key quietly missing a permission, and the typo
    // would be found later by an integration failing in production.
    await expect(CreateNewAPIKey({ name: "typo", scopes: ["monitors.reed"] }, owner)).rejects.toThrow(/Unknown/);
    expect(dbMock.createNewApiKey).not.toHaveBeenCalled();
  });

  it("refuses an empty scope list", async () => {
    await expect(CreateNewAPIKey({ name: "useless", scopes: [] }, owner)).rejects.toThrow(/at least one scope/);
    expect(dbMock.createNewApiKey).not.toHaveBeenCalled();
  });

  it("refuses a nameless key", async () => {
    await expect(CreateNewAPIKey({ name: "", scopes: ["monitors.read"] }, owner)).rejects.toThrow(/Name is required/);
  });

  describe("the permission ceiling", () => {
    it("lets a caller grant what they hold", async () => {
      await expect(CreateNewAPIKey({ name: "ok", scopes: ["monitors.read"] }, limited)).resolves.toBeTruthy();
    });

    it("refuses a scope the caller does not hold", async () => {
      // The escalation this exists to stop: `api_keys.write` must not be a route
      // to permissions the holder was never given.
      await expect(CreateNewAPIKey({ name: "escalate", scopes: ["monitors.write"] }, limited)).rejects.toThrow(
        /do not hold/,
      );
      expect(dbMock.createNewApiKey).not.toHaveBeenCalled();
    });

    it("refuses full access to a caller who is not fully privileged", async () => {
      await expect(CreateNewAPIKey({ name: "god", scopes: ["*"] }, limited)).rejects.toThrow(/full-access/);
      expect(dbMock.createNewApiKey).not.toHaveBeenCalled();
    });

    it("allows full access to a caller who holds every permission", async () => {
      await expect(CreateNewAPIKey({ name: "god", scopes: ["*"] }, owner)).resolves.toBeTruthy();
      expect(lastInsertedScopes()).toEqual(["*"]);
    });

    it("does not apply when there is no caller", async () => {
      // Seeds and scripts have no session. They keep the pre-scoping behaviour.
      await expect(CreateNewAPIKey({ name: "seed", scopes: ["*"] })).resolves.toBeTruthy();
    });
  });

  describe("expiry", () => {
    it("stores no expiry by default", async () => {
      const result = await CreateNewAPIKey({ name: "forever", scopes: ["monitors.read"] }, owner);
      expect(result.expires_at).toBeNull();
    });

    it("treats zero days as never", async () => {
      const result = await CreateNewAPIKey({ name: "zero", scopes: ["monitors.read"], expires_in_days: 0 }, owner);
      expect(result.expires_at).toBeNull();
    });

    it("puts a positive expiry the right distance into the future", async () => {
      const before = Math.floor(Date.now() / 1000);
      const result = await CreateNewAPIKey({ name: "month", scopes: ["monitors.read"], expires_in_days: 30 }, owner);
      expect(result.expires_at).toBeGreaterThanOrEqual(before + 30 * 86400);
      expect(result.expires_at).toBeLessThan(before + 30 * 86400 + 10);
    });

    it("refuses a negative expiry", async () => {
      await expect(
        CreateNewAPIKey({ name: "past", scopes: ["monitors.read"], expires_in_days: -1 }, owner),
      ).rejects.toThrow(/positive/);
    });
  });
});

describe("rotation", () => {
  const existing = {
    id: 7,
    name: "ci-deploy",
    scopes: '["monitors.read"]',
    org_id: null,
    revoked_at: null,
    expires_at: null,
  };

  beforeEach(() => {
    dbMock.getApiKeyById.mockResolvedValue({ ...existing });
  });

  it("carries the old scopes forward and points at the key it replaced", async () => {
    await RotateApiKey({ id: 7 }, owner);
    expect(lastInsertedScopes()).toEqual(["monitors.read"]);
    const inserted = dbMock.createNewApiKey.mock.calls.at(-1)![0];
    expect(inserted.rotated_from).toBe(7);
    // The replacement keeps the name that is written down in runbooks.
    expect(inserted.name).toBe("ci-deploy");
  });

  it("retires the old key on a 24h fuse instead of deleting it", async () => {
    const before = Math.floor(Date.now() / 1000);
    await RotateApiKey({ id: 7 }, owner);
    const [id, name, expiresAt] = dbMock.retireApiKey.mock.calls.at(-1)!;
    expect(id).toBe(7);
    // Unique by construction, so the UNIQUE constraint on `name` still holds
    // with both keys live.
    expect(name).toBe("ci-deploy (rotated #7)");
    expect(expiresAt).toBeGreaterThanOrEqual(before + 86400);
    expect(expiresAt).toBeLessThan(before + 86400 + 10);
  });

  it("never extends a key that was already expiring sooner than the grace window", async () => {
    // Rotating a key with an hour left must not hand it another day.
    const soon = Math.floor(Date.now() / 1000) + 3600;
    dbMock.getApiKeyById.mockResolvedValue({ ...existing, expires_at: soon });
    await RotateApiKey({ id: 7 }, owner);
    const [, , expiresAt] = dbMock.retireApiKey.mock.calls.at(-1)!;
    expect(expiresAt).toBe(soon);
  });

  it("gives the replacement no expiry of its own", async () => {
    const result = await RotateApiKey({ id: 7 }, owner);
    expect(result.expires_at).toBeNull();
  });

  it("can narrow the scopes on the way through", async () => {
    dbMock.getApiKeyById.mockResolvedValue({ ...existing, scopes: '["monitors.read","monitors.write"]' });
    await RotateApiKey({ id: 7, scopes: ["monitors.read"] }, owner);
    expect(lastInsertedScopes()).toEqual(["monitors.read"]);
  });

  it("applies the same ceiling a fresh mint does", async () => {
    // Otherwise rotating somebody else's wide key would be the way around it.
    dbMock.getApiKeyById.mockResolvedValue({ ...existing, scopes: '["*"]' });
    await expect(RotateApiKey({ id: 7 }, limited)).rejects.toThrow(/full-access/);
    expect(dbMock.retireApiKey).not.toHaveBeenCalled();
    expect(dbMock.createNewApiKey).not.toHaveBeenCalled();
  });

  it("refuses to rotate a revoked key", async () => {
    dbMock.getApiKeyById.mockResolvedValue({ ...existing, revoked_at: 1 });
    await expect(RotateApiKey({ id: 7 }, owner)).rejects.toThrow(/revoked/);
  });

  it("refuses a key that does not exist", async () => {
    dbMock.getApiKeyById.mockResolvedValue(undefined);
    await expect(RotateApiKey({ id: 404 }, owner)).rejects.toThrow(/not found/);
  });
});

describe("authenticating a bearer token", () => {
  const live = {
    id: 3,
    name: "live",
    status: "ACTIVE",
    scopes: '["monitors.read"]',
    expires_at: null,
    revoked_at: null,
    org_id: null,
  };

  it("resolves a live key to its scopes", async () => {
    dbMock.getApiKeyByHashedKey.mockResolvedValue({ ...live });
    const principal = await AuthenticateAPIKey("kener_whatever");
    expect(principal).toEqual({ id: 3, name: "live", scopes: ["monitors.read"], orgId: null });
  });

  // Four independent reasons to refuse, checked in one place so no caller can
  // honour a key the others reject.
  it.each([
    ["no matching row", undefined],
    ["an inactive key", { ...live, status: "INACTIVE" }],
    ["a revoked key", { ...live, revoked_at: 1 }],
    ["an expired key", { ...live, expires_at: Math.floor(Date.now() / 1000) - 1 }],
  ])("refuses %s", async (_label, record) => {
    dbMock.getApiKeyByHashedKey.mockResolvedValue(record);
    expect(await AuthenticateAPIKey("kener_whatever")).toBeNull();
    expect(await VerifyAPIKey("kener_whatever")).toBe(false);
  });

  it("refuses a revoked key even when its status was set back to ACTIVE", async () => {
    // Revocation is one-way on purpose; the status switch must not resurrect it.
    dbMock.getApiKeyByHashedKey.mockResolvedValue({ ...live, status: "ACTIVE", revoked_at: 1 });
    expect(await AuthenticateAPIKey("kener_whatever")).toBeNull();
  });

  it("accepts a key whose expiry is still in the future", async () => {
    dbMock.getApiKeyByHashedKey.mockResolvedValue({ ...live, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    expect(await AuthenticateAPIKey("kener_whatever")).not.toBeNull();
  });

  it("keeps VerifyAPIKey's boolean contract for upstream call sites", async () => {
    dbMock.getApiKeyByHashedKey.mockResolvedValue({ ...live });
    expect(await VerifyAPIKey("kener_whatever")).toBe(true);
  });

  it("gives a key with an unparseable scopes column no access at all", async () => {
    dbMock.getApiKeyByHashedKey.mockResolvedValue({ ...live, scopes: "not json" });
    const principal = await AuthenticateAPIKey("kener_whatever");
    expect(principal?.scopes).toEqual([]);
    expect(ApiKeyHasScope(principal!, "monitors.read")).toBe(false);
  });
});

describe("ApiKeyHasScope", () => {
  const principal = { id: 1, name: "k", scopes: ["monitors.read"], orgId: null };
  const wildcard = { id: 2, name: "w", scopes: ["*"], orgId: null };

  it("grants a scope the key holds", () => {
    expect(ApiKeyHasScope(principal, "monitors.read")).toBe(true);
  });

  it("denies one it does not", () => {
    expect(ApiKeyHasScope(principal, "monitors.write")).toBe(false);
  });

  it("grants everything to a wildcard key", () => {
    for (const id of ALL_PERMISSION_IDS) {
      expect(ApiKeyHasScope(wildcard, id)).toBe(true);
    }
  });
});
