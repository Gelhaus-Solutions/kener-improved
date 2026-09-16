import { describe, it, expect, beforeEach, vi } from "vitest";

const fake = {
  getMergeRegions: vi.fn<() => Promise<unknown[]>>(),
  getRegionTargets: vi.fn<(tag: string) => Promise<unknown[]>>(),
  addRegionTarget: vi.fn<(input: unknown) => Promise<number>>(),
  removeRegionTarget: vi.fn<(tag: string) => Promise<number>>(),
  GetMonitorsParsed: vi.fn<(filter: { tag?: string }) => Promise<unknown[]>>(),
  CreateMonitor: vi.fn<(input: unknown) => Promise<number[]>>(),
  UpdateMonitor: vi.fn<(input: unknown) => Promise<number>>(),
};

vi.mock("$lib/server/db/db.js", () => ({
  default: {
    getMergeRegions: () => fake.getMergeRegions(),
    getRegionTargets: (tag: string) => fake.getRegionTargets(tag),
    addRegionTarget: (input: unknown) => fake.addRegionTarget(input),
    removeRegionTarget: (tag: string) => fake.removeRegionTarget(tag),
  },
}));

vi.mock("$lib/server/controllers/monitorsController.js", () => ({
  GetMonitorsParsed: (filter: { tag?: string }) => fake.GetMonitorsParsed(filter),
  CreateMonitor: (input: unknown) => fake.CreateMonitor(input),
  UpdateMonitor: (input: unknown) => fake.UpdateMonitor(input),
}));

const action = (await import("./setMultiRegionEndpoints.js")).default;

const PARENT = {
  id: 1,
  tag: "shop",
  name: "Shop",
  cron: "* * * * *",
  monitor_type: "MULTI_REGION",
  type_data: { endpointType: "API", method: "GET", timeout: 10000, headers: [] },
};

const FRANKFURT = { id: 1, code: "eu-central", name: "Frankfurt", usable_as_target: 1 };
const PROBE_ONLY = { id: 2, code: "us-east", name: "Virginia", usable_as_target: 0 };

beforeEach(() => {
  for (const fn of Object.values(fake)) fn.mockReset();
  fake.getMergeRegions.mockResolvedValue([FRANKFURT, PROBE_ONLY]);
  fake.getRegionTargets.mockResolvedValue([]);
  fake.addRegionTarget.mockResolvedValue(1);
  fake.removeRegionTarget.mockResolvedValue(1);
  fake.CreateMonitor.mockResolvedValue([1]);
  fake.UpdateMonitor.mockResolvedValue(1);
  // The parent resolves; any other tag does not exist yet.
  fake.GetMonitorsParsed.mockImplementation(async (filter) => (filter.tag === "shop" ? [PARENT] : []));
});

const run = (payload: Record<string, unknown>) => action.handler(payload as never);

describe("what it refuses", () => {
  it("refuses a monitor that is not a multi-region service", async () => {
    fake.GetMonitorsParsed.mockResolvedValue([{ ...PARENT, monitor_type: "API" }]);
    await expect(run({ monitor_tag: "shop", endpoints: [] })).rejects.toThrow(/multi-region/i);
  });

  it("refuses two endpoints in the same region, before the database has to", async () => {
    // The unique index would catch it, but the operator would read a constraint
    // name instead of being told which region they listed twice.
    await expect(
      run({
        monitor_tag: "shop",
        endpoints: [
          { region_id: 1, address: "https://a.example" },
          { region_id: 1, address: "https://b.example" },
        ],
      }),
    ).rejects.toThrow(/only one endpoint per region/i);
  });

  it("refuses an endpoint with no address", async () => {
    await expect(run({ monitor_tag: "shop", endpoints: [{ region_id: 1, address: "  " }] })).rejects.toThrow(
      /address/i,
    );
  });

  it("refuses a region that is not marked as somewhere a service is deployed", async () => {
    // The Q1 marker, enforced rather than merely displayed. A probe-only region
    // is a place checks run FROM.
    await expect(
      run({ monitor_tag: "shop", endpoints: [{ region_id: 2, address: "https://a.example" }] }),
    ).rejects.toThrow(/not marked/i);
  });

  it("creates nothing at all when one endpoint in the list is invalid", async () => {
    await expect(
      run({
        monitor_tag: "shop",
        endpoints: [
          { region_id: 1, address: "https://a.example" },
          { region_id: 2, address: "https://b.example" },
        ],
      }),
    ).rejects.toThrow();
    // Validation of the whole list happens before any monitor is written, so a
    // half-applied service cannot exist.
    expect(fake.CreateMonitor).not.toHaveBeenCalled();
  });
});

describe("what it creates", () => {
  it("creates a hidden endpoint monitor carrying the shared config and its own URL", async () => {
    await run({ monitor_tag: "shop", endpoints: [{ region_id: 1, address: "https://eu.example" }] });

    expect(fake.CreateMonitor).toHaveBeenCalledTimes(1);
    const created = fake.CreateMonitor.mock.calls[0][0] as Record<string, unknown>;
    expect(created.tag).toBe("shop__eu-central");
    expect(created.is_hidden).toBe("YES");
    expect(created.monitor_type).toBe("API");
    expect(created.cron).toBe("* * * * *");

    const typeData = JSON.parse(String(created.type_data));
    expect(typeData.url).toBe("https://eu.example");
    expect(typeData.method).toBe("GET");
    // `endpointType` says what kind of check these are; it is not part of an
    // endpoint's own configuration and must not be copied down.
    expect(typeData.endpointType).toBeUndefined();
  });

  it("records the relationship as well as the monitor", async () => {
    await run({ monitor_tag: "shop", endpoints: [{ region_id: 1, address: "https://eu.example" }] });
    expect(fake.addRegionTarget).toHaveBeenCalledWith({
      parentTag: "shop",
      childTag: "shop__eu-central",
      regionId: 1,
    });
  });
});

describe("what it does when a region is removed", () => {
  beforeEach(() => {
    fake.getRegionTargets.mockResolvedValue([{ parent_tag: "shop", child_tag: "shop__eu-central", region_id: 1 }]);
    fake.GetMonitorsParsed.mockImplementation(async (filter) => {
      if (filter.tag === "shop") return [PARENT];
      if (filter.tag === "shop__eu-central") return [{ id: 9, tag: "shop__eu-central", status: "ACTIVE" }];
      return [];
    });
  });

  it("DEACTIVATES the endpoint monitor rather than deleting it", async () => {
    // Deleting would take ninety days of history with it, and an operator
    // removing a region has not asked to destroy what it reported.
    const result = (await run({ monitor_tag: "shop", endpoints: [] })) as { removed: number };

    expect(result.removed).toBe(1);
    const updated = fake.UpdateMonitor.mock.calls[0][0] as Record<string, unknown>;
    expect(updated.status).toBe("INACTIVE");
    expect(fake.removeRegionTarget).toHaveBeenCalledWith("shop__eu-central");
  });

  it("reuses the existing monitor when the region comes back, keeping its history", async () => {
    // Same tag, so `monitoring_data` still finds every bar it ever recorded.
    await run({ monitor_tag: "shop", endpoints: [{ region_id: 1, address: "https://new.example" }] });

    expect(fake.CreateMonitor).not.toHaveBeenCalled();
    const updated = fake.UpdateMonitor.mock.calls[0][0] as Record<string, unknown>;
    expect(updated.status).toBe("ACTIVE");
    expect(JSON.parse(String(updated.type_data)).url).toBe("https://new.example");
    // The relationship already exists, so it is not added twice.
    expect(fake.addRegionTarget).not.toHaveBeenCalled();
  });
});
