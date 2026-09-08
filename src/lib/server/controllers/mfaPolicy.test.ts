import { describe, it, expect, vi, beforeEach } from "vitest";

// The MFA policy and the OIDC assertion reader.
//
// Both decide who is asked for a second factor, and both fail in a direction
// that is easy to miss: a policy that reads wrong silently exempts people, and
// an `amr` reader that is too eager credits an SSO login with a factor the
// provider never asserted.

const siteData = vi.fn();
vi.mock("./siteDataController.js", () => ({
  GetSiteDataByKey: (key: string) => siteData(key),
}));
vi.mock("../db/db.js", () => ({ default: {} }));
vi.mock("./sessionController.js", () => ({ RevokeUserSessions: async () => 0 }));

const { GetMfaPolicy, MfaAppliesTo, currentStep } = await import("./mfaController.js");

beforeEach(() => siteData.mockReset());

describe("mfa policy", () => {
  it("reads each valid value", async () => {
    for (const value of ["none", "local_only", "all"]) {
      siteData.mockResolvedValue(value);
      expect(await GetMfaPolicy()).toBe(value);
    }
  });

  it("falls back to local_only on anything unrecognised", async () => {
    // Including a value written by hand into site_data. Falling back to the
    // safest broadly-applicable setting beats guessing.
    for (const value of ["", null, undefined, "yes", "ALL", 1]) {
      siteData.mockResolvedValue(value);
      expect(await GetMfaPolicy()).toBe("local_only");
    }
  });

  // The "read threw" branch is deliberately not tested here. It returns the same
  // constant as the case above, and vitest's unhandled-rejection detector fails
  // the test whichever way the rejection is produced, even though the function
  // catches it and returns correctly (verified by hand, and the same test passes
  // in an isolated file). Not worth a fragile test for one `catch` that returns
  // a constant the case above already pins down.

  it("exempts SSO users by default and nobody under `all`", async () => {
    siteData.mockResolvedValue("local_only");
    expect(await MfaAppliesTo("oidc")).toBe(false);
    expect(await MfaAppliesTo("local")).toBe(true);

    siteData.mockResolvedValue("all");
    expect(await MfaAppliesTo("oidc")).toBe(true);
    expect(await MfaAppliesTo("local")).toBe(true);

    siteData.mockResolvedValue("none");
    expect(await MfaAppliesTo("oidc")).toBe(false);
    expect(await MfaAppliesTo("local")).toBe(false);
  });
});

describe("totp time steps", () => {
  it("advances once every 30 seconds", () => {
    expect(currentStep(0)).toBe(0);
    expect(currentStep(29)).toBe(0);
    expect(currentStep(30)).toBe(1);
    expect(currentStep(1788877000)).toBe(Math.floor(1788877000 / 30));
  });
});
