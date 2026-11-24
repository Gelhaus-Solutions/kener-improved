import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeDb = vi.hoisted(() => ({
  getStandbyState: vi.fn(),
  getLatestMigrationName: vi.fn(),
  applyStandbyPage: vi.fn(),
}));
vi.mock("../db/db.js", () => ({ default: fakeDb }));
vi.mock("../cache/siteDataCache.js", () => ({ InvalidateAllSiteDataCaches: vi.fn(async () => {}) }));
vi.mock("../cache/rollupVersion.js", () => ({ bumpRollupVersion: vi.fn(async () => {}) }));

import { PullFromPrimary } from "./pull.js";
import type { StandbyExportPage } from "./tables.js";

const KEYS = ["KENER_STANDBY_TOKEN", "KENER_STANDBY_PRIMARY_URL"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function page(over: Partial<StandbyExportPage>): StandbyExportPage {
  return {
    format: 1,
    schema: "m2.ts",
    generatedAt: 5000,
    windows: { rawFrom: 0, rollupFrom: 0 },
    snapshot: null,
    images: null,
    imagesFingerprint: null,
    delta: {},
    next: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.KENER_STANDBY_TOKEN = "t0ken";
  process.env.KENER_STANDBY_PRIMARY_URL = "https://primary.example/status/";
  fakeDb.getStandbyState.mockResolvedValue({ data_at: 4000, images_fingerprint: "ff00" });
  fakeDb.getLatestMigrationName.mockResolvedValue("m2.ts");
  fakeDb.applyStandbyPage.mockResolvedValue({ rows: 1, touchedTags: [], orgIds: [] });
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("PullFromPrimary", () => {
  it("follows the cursor to the last page and marks only that one final", async () => {
    const pages = [
      page({ snapshot: {}, imagesFingerprint: "ff00", next: "c1" }),
      page({ generatedAt: 5001, next: "c2" }),
      page({ generatedAt: 5002 }),
    ];
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(pages.shift())));

    const result = await PullFromPrimary(fetchImpl);

    expect(result).toEqual({ pages: 3, rows: 3, dataAt: 5000 });
    const urls = fetchImpl.mock.calls.map((c) => new URL(c[0]));
    expect(urls[0].pathname).toBe("/status/ext/standby/export");
    expect(urls[0].searchParams.get("since")).toBe("4000");
    expect(urls[0].searchParams.get("images")).toBe("ff00");
    expect(urls.map((u) => u.searchParams.get("after"))).toEqual([null, "c1", "c2"]);
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer t0ken" });
    expect(fakeDb.applyStandbyPage.mock.calls.map((c) => [c[1].first, c[1].final, c[1].dataAt])).toEqual([
      [true, false, 5000],
      [false, false, 5000],
      [false, true, 5000],
    ]);
  });

  it("applies nothing from a primary on another schema", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(page({ schema: "m3.ts" }))));
    await expect(PullFromPrimary(fetchImpl)).rejects.toThrow(/schema differs/);
    expect(fakeDb.applyStandbyPage).not.toHaveBeenCalled();
  });

  it("fails on a refused request or an unknown format", async () => {
    await expect(PullFromPrimary(vi.fn(async () => new Response("no", { status: 401 })))).rejects.toThrow(/401/);
    await expect(PullFromPrimary(vi.fn(async () => new Response(JSON.stringify({ format: 2 }))))).rejects.toThrow(
      /format/,
    );
    expect(fakeDb.applyStandbyPage).not.toHaveBeenCalled();
  });

  it("needs both the primary's URL and the token", async () => {
    delete process.env.KENER_STANDBY_PRIMARY_URL;
    const fetchImpl = vi.fn();
    await expect(PullFromPrimary(fetchImpl)).rejects.toThrow(/KENER_STANDBY_PRIMARY_URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
