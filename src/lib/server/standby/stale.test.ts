import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Knex from "knex";
import type { Knex as KnexType } from "knex";

const fakeDb = vi.hoisted(() => ({
  getStandbyFreshness: vi.fn(),
  getLatestMonitoringDataAllActive: vi.fn(),
  getDeclaredIncidentImpacts: vi.fn(),
  getDeclaredMaintenanceImpacts: vi.fn(),
  getAllDependencies: vi.fn(),
  getAllRollupSettings: vi.fn(),
  getMonitorsByType: vi.fn(),
}));
vi.mock("../db/db.js", () => ({ default: fakeDb }));

import { ComputeStandbyFreshness, ReadStandbyFreshness, ResetStandbyFreshnessMemo } from "./freshness.js";
import { GetStandbyNotice } from "./status.js";
import { getPageStatus } from "../incidents/pageStatus.js";
import { MonitoringRepository } from "../db/repositories/monitoring.js";
import { unscoped } from "../db/repositories/testSupport.js";
import { up as createStandbyState } from "../../../../migrations/20261124120000_add_standby_state.js";
import GC from "../../global-constants.js";

const KEYS = ["KENER_ROLE", "KENER_STANDBY_STALE_SECONDS"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  ResetStandbyFreshnessMemo();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("ComputeStandbyFreshness", () => {
  const state = { last_pull_at: 1000, data_at: 990, last_attempt_at: 1000, last_error: null };

  it("is current up to the threshold and stale past it", () => {
    expect(ComputeStandbyFreshness(state, 1300, 300)).toMatchObject({ stale: false, ageSeconds: 300, dataAt: 990 });
    expect(ComputeStandbyFreshness(state, 1301, 300)).toMatchObject({ stale: true, ageSeconds: 301 });
  });

  it("is stale before the first good pull", () => {
    expect(ComputeStandbyFreshness(null, 1000, 300)).toMatchObject({ stale: true, lastPullAt: null, ageSeconds: null });
    expect(
      ComputeStandbyFreshness(
        { last_pull_at: null, data_at: null, last_attempt_at: 990, last_error: "502" },
        1000,
        300,
      ),
    ).toMatchObject({ stale: true, lastError: "502" });
  });
});

async function standbyDb(lastPullAt: number | null): Promise<KnexType> {
  const db = Knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  await createStandbyState(db);
  await db.schema.createTable("monitoring_data", (t) => {
    t.integer("org_id");
    t.string("monitor_tag");
    t.integer("region_id");
    t.integer("timestamp");
    t.string("status");
  });
  await db("monitoring_data").insert({ org_id: 1, monitor_tag: "api", region_id: 0, timestamp: 1000, status: "UP" });
  if (lastPullAt !== null) await db("standby_state").insert({ id: 1, last_pull_at: lastPullAt, data_at: lastPullAt });
  return db;
}

describe("the stale threshold, read from standby_state", () => {
  it("reads nothing on a primary", async () => {
    delete process.env.KENER_ROLE;
    const db = await standbyDb(null);
    expect(await ReadStandbyFreshness(db)).toBeNull();
    await db.destroy();
  });

  it("honours KENER_STANDBY_STALE_SECONDS", async () => {
    process.env.KENER_ROLE = "standby";
    process.env.KENER_STANDBY_STALE_SECONDS = "60";
    const db = await standbyDb(1000);
    expect(await ReadStandbyFreshness(db, 1060_000)).toMatchObject({ stale: false, staleAfterSeconds: 60 });
    ResetStandbyFreshnessMemo();
    expect(await ReadStandbyFreshness(db, 1061_000)).toMatchObject({ stale: true });
    await db.destroy();
  });

  it("turns the latest sample into no sample once stale, so a component reads No Data, not its last green", async () => {
    process.env.KENER_ROLE = "standby";
    vi.useFakeTimers();
    const db = await standbyDb(1000);
    const repo = unscoped(new MonitoringRepository(db));

    vi.setSystemTime(1200_000);
    expect((await repo.getLatestMonitoringData("api"))?.status).toBe("UP");

    ResetStandbyFreshnessMemo();
    vi.setSystemTime(1301_000);
    expect(await repo.getLatestMonitoringData("api")).toBeUndefined();
    expect(await repo.getLatestMonitoringDataAllActive(["api"])).toEqual([]);
    await db.destroy();
  });

  it("leaves a primary's latest sample alone", async () => {
    delete process.env.KENER_ROLE;
    const db = await standbyDb(null);
    const repo = unscoped(new MonitoringRepository(db));
    expect((await repo.getLatestMonitoringData("api"))?.status).toBe("UP");
    await db.destroy();
  });
});

describe("the page status on a stale standby", () => {
  beforeEach(() => {
    fakeDb.getLatestMonitoringDataAllActive.mockResolvedValue([{ monitor_tag: "api", status: GC.UP }]);
    fakeDb.getDeclaredIncidentImpacts.mockResolvedValue([
      { monitor_tag: "web", monitor_impact: "DOWN", component_impact: "MAJOR_OUTAGE", impact_override: null },
    ]);
    fakeDb.getDeclaredMaintenanceImpacts.mockResolvedValue([]);
    fakeDb.getAllDependencies.mockResolvedValue([]);
    fakeDb.getAllRollupSettings.mockResolvedValue([]);
    fakeDb.getMonitorsByType.mockResolvedValue([]);
  });

  it("states every component as unknown, declared impacts included", async () => {
    fakeDb.getStandbyFreshness.mockResolvedValue({ stale: true, dataAt: 1000 });
    const status = await getPageStatus(["api", "web"], 2000);
    expect(status.status).toBe(GC.NO_DATA);
    expect(status.components.map((c) => c.source)).toEqual(["silent", "silent"]);
    expect(fakeDb.getDeclaredIncidentImpacts).not.toHaveBeenCalled();
  });

  it("derives as usual while current", async () => {
    fakeDb.getStandbyFreshness.mockResolvedValue({ stale: false, dataAt: 1000 });
    const status = await getPageStatus(["api", "web"], 2000);
    expect(status.components.map((c) => c.source)).toEqual(["monitoring", "incident"]);
    expect(status.status).toBe(GC.DOWN);
  });
});

describe("the banner", () => {
  it("shows the banner with the data time once stale", async () => {
    fakeDb.getStandbyFreshness.mockResolvedValue({ stale: true, dataAt: 1000 });
    expect(await GetStandbyNotice()).toEqual({ dataAt: 1000 });
  });

  it("shows no banner while current, or on a primary", async () => {
    fakeDb.getStandbyFreshness.mockResolvedValue({ stale: false, dataAt: 1000 });
    expect(await GetStandbyNotice()).toBeNull();
    fakeDb.getStandbyFreshness.mockResolvedValue(null);
    expect(await GetStandbyNotice()).toBeNull();
  });
});
