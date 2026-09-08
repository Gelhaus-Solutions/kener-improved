import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionContext } from "../types.js";

// The admin API's half of A2b's enforcement.
//
// The allowlist here is the thing most worth a test. Too wide and an unenrolled
// user keeps doing real work; too narrow and every user is locked out of the
// only screen that can unlock them, with no way back except an operator editing
// site_data by hand.

const requires = vi.fn(async () => false);
vi.mock("$lib/server/controllers/mfaController.js", () => ({
  RequiresMfaEnrolment: (...args: unknown[]) => requires(...(args as [])),
}));

const { requireMfaEnrolment, MFA_ENROLMENT_REQUIRED } = await import("./requireMfa.js");

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    user: { id: 1, email: "a@b.c", auth_provider: "local" },
    permissions: new Set<string>(),
    session: { id: "s1", mfa_level: "none" },
    requestId: "r1",
    cookies: {},
    ip: null,
    userAgent: null,
    ...overrides,
  } as unknown as ActionContext;
}

beforeEach(() => requires.mockReset());

describe("requireMfaEnrolment", () => {
  it("lets everything through when nothing is owed", async () => {
    requires.mockResolvedValue(false);
    await expect(requireMfaEnrolment("deleteMonitor", ctx())).resolves.toBeUndefined();
  });

  it("blocks an ordinary action when enrolment is outstanding", async () => {
    requires.mockResolvedValue(true);
    await expect(requireMfaEnrolment("deleteMonitor", ctx())).rejects.toMatchObject({
      status: 403,
      message: MFA_ENROLMENT_REQUIRED,
    });
  });

  it("blocks reads too, not just writes", async () => {
    // The policy is about who may use the instance at all, not about who may
    // change it. A read-only escape hatch would leak the whole admin surface.
    requires.mockResolvedValue(true);
    await expect(requireMfaEnrolment("getMonitors", ctx())).rejects.toMatchObject({ status: 403 });
  });

  it.each(["getMfaStatus", "beginMfaEnrolment", "confirmMfaEnrolment"])(
    "always allows %s, so enrolment can actually be completed",
    async (action) => {
      requires.mockResolvedValue(true);
      await expect(requireMfaEnrolment(action, ctx())).resolves.toBeUndefined();
    },
  );

  it("does not even ask the policy for an enrolment action", async () => {
    // The allowlist short-circuits, so the common path during enrolment costs no
    // extra queries.
    requires.mockResolvedValue(true);
    await requireMfaEnrolment("beginMfaEnrolment", ctx());
    expect(requires).not.toHaveBeenCalled();
  });

  it("blocks disableMfa while enrolment is outstanding", async () => {
    // Deliberately not on the allowlist. It is unreachable without a confirmed
    // factor anyway, and allowing it would let somebody satisfy the policy and
    // immediately undo it while still holding the same session.
    requires.mockResolvedValue(true);
    await expect(requireMfaEnrolment("disableMfa", ctx())).rejects.toMatchObject({ status: 403 });
  });

  it("passes the user and their session's MFA level to the policy", async () => {
    requires.mockResolvedValue(false);
    await requireMfaEnrolment("getMonitors", ctx({ session: { id: "s1", mfa_level: "idp" } as never }));
    expect(requires).toHaveBeenCalledWith("local", 1, "idp");
  });
});
