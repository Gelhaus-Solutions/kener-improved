import { describe, it, expect, vi, beforeEach } from "vitest";

// A2b: the half that makes `mfaPolicy` binding.
//
// A2 shipped the policy and used it to decide who was *offered* enrolment, so
// setting it to `all` changed nothing for a user who simply never turned MFA on.
// These are the predicates that changed that, and they fail in directions that
// are invisible from the outside: too lax and the policy is decoration, too
// strict and a user is locked out of the only screen that could unlock them.

const siteData = vi.fn();
vi.mock("./siteDataController.js", () => ({
  GetSiteDataByKey: (key: string) => siteData(key),
}));
vi.mock("./sessionController.js", () => ({ RevokeUserSessions: async () => 0 }));

const dbMock = {
  getTotp: vi.fn(async (_userId: number) => undefined as { confirmed_at: number | null } | undefined),
  getUserPasswordHashById: vi.fn(async (_id: number) => undefined as { password_hash: string } | undefined),
  getAllUsers: vi.fn(async () => [] as Array<{ id: number; is_active: number }>),
  getUserIdsWithConfirmedTotp: vi.fn(async () => [] as number[]),
  countRecoveryCodes: vi.fn(async () => ({ total: 0, unused: 0 })),
};
vi.mock("../db/db.js", () => ({ default: dbMock }));

const { RequiresMfaEnrolment, PasswordlessEnrolmentAllowed, GetMfaCoverage } = await import("./mfaController.js");

const CONFIRMED = { confirmed_at: 1_700_000_000 };
const UNCONFIRMED = { confirmed_at: null };

beforeEach(() => {
  siteData.mockReset();
  for (const fn of Object.values(dbMock)) fn.mockReset();
  dbMock.getTotp.mockResolvedValue(undefined);
  dbMock.getUserPasswordHashById.mockResolvedValue(undefined);
  dbMock.getAllUsers.mockResolvedValue([]);
  dbMock.getUserIdsWithConfirmedTotp.mockResolvedValue([]);
});

describe("RequiresMfaEnrolment", () => {
  it("never requires anything under policy `none`", async () => {
    siteData.mockResolvedValue("none");
    expect(await RequiresMfaEnrolment("local", 1, "none")).toBe(false);
    expect(await RequiresMfaEnrolment("oidc", 1, "none")).toBe(false);
  });

  describe("under `local_only`", () => {
    beforeEach(() => siteData.mockResolvedValue("local_only"));

    it("requires a password user with no factor to enrol", async () => {
      expect(await RequiresMfaEnrolment("local", 1, "none")).toBe(true);
    });

    it("leaves a password user who already enrolled alone", async () => {
      dbMock.getTotp.mockResolvedValue(CONFIRMED);
      expect(await RequiresMfaEnrolment("local", 1, "none")).toBe(false);
    });

    it("exempts SSO users entirely", async () => {
      expect(await RequiresMfaEnrolment("oidc", 1, "none")).toBe(false);
    });
  });

  describe("under `all`", () => {
    beforeEach(() => siteData.mockResolvedValue("all"));

    it("requires a password user with no factor to enrol", async () => {
      expect(await RequiresMfaEnrolment("local", 1, "none")).toBe(true);
    });

    it("requires an SSO user whose provider asserted nothing to enrol", async () => {
      // This is the case that makes the passwordless-enrolment exemption
      // load-bearing: without it, this user is required to enrol and cannot.
      expect(await RequiresMfaEnrolment("oidc", 1, "none")).toBe(true);
    });

    it("accepts a factor already cleared at the identity provider", async () => {
      // They have done the thing the policy asks for, just not at Kener.
      expect(await RequiresMfaEnrolment("oidc", 1, "idp")).toBe(false);
    });

    it("leaves anyone with a confirmed factor alone", async () => {
      dbMock.getTotp.mockResolvedValue(CONFIRMED);
      expect(await RequiresMfaEnrolment("local", 1, "totp")).toBe(false);
      expect(await RequiresMfaEnrolment("oidc", 1, "none")).toBe(false);
    });

    it("does NOT accept an abandoned half-finished enrolment", async () => {
      // Otherwise the way around the policy is to start enrolling and walk away.
      dbMock.getTotp.mockResolvedValue(UNCONFIRMED);
      expect(await RequiresMfaEnrolment("local", 1, "none")).toBe(true);
    });

    it("is not satisfied by a `totp` session level on its own", async () => {
      // Only `idp` short-circuits. A `totp` level without a confirmed row would
      // mean the row was deleted underneath a live session, and that session
      // must not keep coasting on it.
      dbMock.getTotp.mockResolvedValue(undefined);
      expect(await RequiresMfaEnrolment("local", 1, "totp")).toBe(true);
    });

    it("treats a missing session level as no factor", async () => {
      expect(await RequiresMfaEnrolment("local", 1, undefined)).toBe(true);
      expect(await RequiresMfaEnrolment("local", 1, null)).toBe(true);
    });
  });

  it("falls back to local_only when the policy cannot be read", async () => {
    siteData.mockResolvedValue("nonsense");
    expect(await RequiresMfaEnrolment("oidc", 1, "none")).toBe(false);
    expect(await RequiresMfaEnrolment("local", 1, "none")).toBe(true);
  });
});

describe("PasswordlessEnrolmentAllowed", () => {
  it("allows an OIDC account that has no password hash", async () => {
    dbMock.getUserPasswordHashById.mockResolvedValue(undefined);
    expect(await PasswordlessEnrolmentAllowed(1, "oidc")).toBe(true);
  });

  it("allows an OIDC account whose hash column is empty", async () => {
    dbMock.getUserPasswordHashById.mockResolvedValue({ password_hash: "" });
    expect(await PasswordlessEnrolmentAllowed(1, "oidc")).toBe(true);
  });

  it("refuses an OIDC account that does have a password", async () => {
    // They can be asked for it, so they are asked for it.
    dbMock.getUserPasswordHashById.mockResolvedValue({ password_hash: "$2b$10$abcdefghij" });
    expect(await PasswordlessEnrolmentAllowed(1, "oidc")).toBe(false);
  });

  it("refuses a local account even with no hash", async () => {
    // Not reachable in practice, and failing closed is the right direction: the
    // exemption exists for accounts that structurally cannot have a password,
    // not for accounts that happen to be missing one.
    dbMock.getUserPasswordHashById.mockResolvedValue(undefined);
    expect(await PasswordlessEnrolmentAllowed(1, "local")).toBe(false);
    expect(await PasswordlessEnrolmentAllowed(1, null)).toBe(false);
  });

  it("does not read the password hash for a local account at all", async () => {
    await PasswordlessEnrolmentAllowed(1, "local");
    expect(dbMock.getUserPasswordHashById).not.toHaveBeenCalled();
  });
});

describe("GetMfaCoverage", () => {
  beforeEach(() => siteData.mockResolvedValue("local_only"));

  it("counts active users only", async () => {
    // A deactivated account cannot sign in, so it cannot be locked out, and
    // counting it would overstate how many people a policy change will stop.
    dbMock.getAllUsers.mockResolvedValue([
      { id: 1, is_active: 1 },
      { id: 2, is_active: 1 },
      { id: 3, is_active: 0 },
    ]);
    dbMock.getUserIdsWithConfirmedTotp.mockResolvedValue([1, 3]);

    const coverage = await GetMfaCoverage(1);
    expect(coverage.total).toBe(2);
    expect(coverage.covered).toBe(1);
    expect(coverage.uncovered).toBe(1);
  });

  it("reports whether the caller themselves is covered", async () => {
    dbMock.getAllUsers.mockResolvedValue([
      { id: 1, is_active: 1 },
      { id: 2, is_active: 1 },
    ]);
    dbMock.getUserIdsWithConfirmedTotp.mockResolvedValue([2]);

    expect((await GetMfaCoverage(1)).caller_covered).toBe(false);
    expect((await GetMfaCoverage(2)).caller_covered).toBe(true);
  });

  it("carries the current policy, so one call renders the whole card", async () => {
    siteData.mockResolvedValue("all");
    expect((await GetMfaCoverage(1)).policy).toBe("all");
  });
});
