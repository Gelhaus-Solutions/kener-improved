import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeDb = vi.hoisted(() => ({ getStandbyFreshness: vi.fn() }));
vi.mock("../db/db.js", () => ({ default: fakeDb }));

import { GetInstanceHealth } from "./health.js";
import { ComputeStandbyFreshness } from "./freshness.js";

const saved = process.env.KENER_ROLE;
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (saved === undefined) delete process.env.KENER_ROLE;
  else process.env.KENER_ROLE = saved;
});

describe("GET /healthcheck/instance", () => {
  it("reports the role, the last pull and the data age", async () => {
    delete process.env.KENER_ROLE;
    expect(await GetInstanceHealth()).toEqual({ role: "primary", ok: true });

    process.env.KENER_ROLE = "standby";
    fakeDb.getStandbyFreshness.mockResolvedValue(
      ComputeStandbyFreshness(
        { last_pull_at: 1000, data_at: 995, last_attempt_at: 1400, last_error: "502" },
        1400,
        300,
      ),
    );
    expect(await GetInstanceHealth()).toEqual({
      role: "standby",
      ok: false,
      lastPullAt: 1000,
      dataAt: 995,
      dataAgeSeconds: 400,
      staleAfterSeconds: 300,
      stale: true,
      lastAttemptAt: 1400,
      lastAttemptFailed: true,
    });
  });

  it("is ok on a standby whose last pull is current", async () => {
    process.env.KENER_ROLE = "standby";
    fakeDb.getStandbyFreshness.mockResolvedValue(
      ComputeStandbyFreshness({ last_pull_at: 1000, data_at: 999, last_attempt_at: 1000, last_error: null }, 1030, 300),
    );
    expect(await GetInstanceHealth()).toMatchObject({ role: "standby", ok: true, dataAgeSeconds: 30, stale: false });
  });
});
