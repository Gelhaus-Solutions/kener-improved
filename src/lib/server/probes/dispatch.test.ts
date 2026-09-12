import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MonitorRecordTyped } from "../types/db.js";
import type { ProbeAgentRecord, ProbeTarget } from "../db/repositories/probes.js";

const fake = {
  getProbeTargetsForMonitor: vi.fn<(tag: string) => Promise<ProbeTarget[]>>(),
  getMergeRegions: vi.fn<() => Promise<unknown[]>>(),
  getMonitorMergePolicy: vi.fn<() => Promise<unknown>>(),
  getMonitorSourcePolicies: vi.fn<() => Promise<unknown[]>>(),
  GetSiteDataByKey: vi.fn<() => Promise<unknown>>(),
};

vi.mock("../db/db.js", () => ({
  default: {
    getProbeTargetsForMonitor: (tag: string) => fake.getProbeTargetsForMonitor(tag),
    // B1d's cascade. Empty everywhere means "inherit the shipped defaults",
    // which is what an install that has configured nothing actually has.
    getMergeRegions: () => fake.getMergeRegions(),
    getMonitorMergePolicy: () => fake.getMonitorMergePolicy(),
    getMonitorSourcePolicies: () => fake.getMonitorSourcePolicies(),
  },
}));

vi.mock("../controllers/siteDataController.js", () => ({
  GetSiteDataByKey: () => fake.GetSiteDataByKey(),
}));

const { planProbeExecution, runOnProbe, dispatchSample, isProbeEligible } = await import("./dispatch.js");
const { LOCAL_REGION_ID } = await import("./merge.js");
const registry = await import("./registry.js");

function agent(overrides: Partial<ProbeAgentRecord> = {}): ProbeAgentRecord {
  return {
    id: 1,
    org_id: 1,
    name: "Frankfurt",
    region_id: 3,
    token_hash: "hash",
    token_hint: "abcd",
    status: "ACTIVE",
    connection_state: "CONNECTED",
    agent_version: "1.0.0",
    capabilities: null,
    last_seen_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function target(overrides: Partial<ProbeTarget> = {}): ProbeTarget {
  return {
    assignment_id: 1,
    monitor_tag: "api",
    mode: "REMOTE_PREFERRED",
    agent_id: 1,
    agent_name: "Frankfurt",
    region_id: 3,
    status: "ACTIVE",
    connection_state: "CONNECTED",
    ...overrides,
  };
}

function monitor(overrides: Partial<MonitorRecordTyped> = {}): MonitorRecordTyped {
  return {
    tag: "api",
    monitor_type: "API",
    type_data: { url: "https://example.com", timeout: 1000 },
    ...overrides,
  } as MonitorRecordTyped;
}

beforeEach(() => {
  registry.clear("test reset");
  for (const spy of Object.values(fake)) spy.mockReset();
  fake.getProbeTargetsForMonitor.mockResolvedValue([]);
  fake.getMergeRegions.mockResolvedValue([]);
  fake.getMonitorMergePolicy.mockResolvedValue(undefined);
  fake.getMonitorSourcePolicies.mockResolvedValue([]);
  fake.GetSiteDataByKey.mockResolvedValue(null);
});

describe("isProbeEligible", () => {
  it("allows only the types that need nothing but the monitor row", () => {
    for (const type of ["API", "PING", "TCP", "DNS", "SSL"]) expect(isProbeEligible(type)).toBe(true);
    // Each of these needs something only Kener has: Redis, the database, or a
    // connection it holds.
    for (const type of ["GROUP", "HEARTBEAT", "SQL", "PROMETHEUS", "DOCKER", "NONE"]) {
      expect(isProbeEligible(type)).toBe(false);
    }
  });
});

describe("planProbeExecution", () => {
  it("does not even look up assignments for an ineligible type", async () => {
    const plan = await planProbeExecution(monitor({ monitor_type: "GROUP" }));
    expect(plan.voting).toEqual([]);
    expect(plan.displayOnly).toEqual([]);
    expect(plan.localSlot).toBeNull();
    // The overwhelming majority of checks take this path, so it has to cost
    // nothing. A query here would be one per monitor per minute, forever.
    expect(fake.getProbeTargetsForMonitor).not.toHaveBeenCalled();
    // And the cascade is not read either, which is what keeps B1d off the hot
    // path of an install that uses no probes.
    expect(fake.GetSiteDataByKey).not.toHaveBeenCalled();
  });

  it("does not read the cascade for a monitor with no assignments", async () => {
    const plan = await planProbeExecution(monitor());
    expect(plan.voting).toEqual([]);
    expect(fake.GetSiteDataByKey).not.toHaveBeenCalled();
  });

  it("returns a local-only plan when the assigned agent is not connected", async () => {
    fake.getProbeTargetsForMonitor.mockResolvedValue([target()]);
    // The agent has an assignment but no live socket.
    const plan = await planProbeExecution(monitor());
    expect(plan.voting).toEqual([]);
    expect(plan.localSlot).toBeNull();
  });

  it("treats a region 0 agent as the local slot, because that is what it always meant", async () => {
    registry.register(agent({ id: 1, region_id: 0 }), vi.fn(), vi.fn());
    fake.getProbeTargetsForMonitor.mockResolvedValue([target({ agent_id: 1, region_id: 0 })]);

    const plan = await planProbeExecution(monitor());

    // Nothing may observe at region 0 under B1d: region 0 is the computed
    // answer. B1c's "replaces the local check" is exactly the local source.
    expect(plan.localSlot?.connection.agent.id).toBe(1);
    expect(plan.localSlot?.regionId).toBe(LOCAL_REGION_ID);
    expect(plan.voting.map((s) => s.regionId)).toEqual([LOCAL_REGION_ID]);
  });

  it("puts a region >= 1 agent in voting at its own region", async () => {
    registry.register(agent({ id: 2, region_id: 3 }), vi.fn(), vi.fn());
    fake.getProbeTargetsForMonitor.mockResolvedValue([target({ agent_id: 2, region_id: 3 })]);

    const plan = await planProbeExecution(monitor());
    expect(plan.localSlot).toBeNull();
    expect(plan.voting.map((s) => s.regionId)).toEqual([3]);
  });

  it("routes a DISPLAY_ONLY region away from the vote", async () => {
    registry.register(agent({ id: 2, region_id: 3 }), vi.fn(), vi.fn());
    fake.getProbeTargetsForMonitor.mockResolvedValue([target({ agent_id: 2, region_id: 3 })]);
    fake.getMergeRegions.mockResolvedValue([{ id: 3, default_mode: "DISPLAY_ONLY" }]);

    const plan = await planProbeExecution(monitor());
    expect(plan.voting).toEqual([]);
    expect(plan.displayOnly.map((s) => s.regionId)).toEqual([3]);
  });

  it("does not dispatch an OFF region at all", async () => {
    registry.register(agent({ id: 2, region_id: 3 }), vi.fn(), vi.fn());
    fake.getProbeTargetsForMonitor.mockResolvedValue([target({ agent_id: 2, region_id: 3 })]);
    fake.getMergeRegions.mockResolvedValue([{ id: 3, default_mode: "OFF" }]);

    const plan = await planProbeExecution(monitor());
    expect(plan.voting).toEqual([]);
    expect(plan.displayOnly).toEqual([]);
  });

  it("lets a per-monitor override beat the region default", async () => {
    registry.register(agent({ id: 2, region_id: 3 }), vi.fn(), vi.fn());
    fake.getProbeTargetsForMonitor.mockResolvedValue([target({ agent_id: 2, region_id: 3 })]);
    fake.getMergeRegions.mockResolvedValue([{ id: 3, default_mode: "OFF" }]);
    fake.getMonitorSourcePolicies.mockResolvedValue([{ region_id: 3, mode: "VOTE" }]);

    const plan = await planProbeExecution(monitor());
    expect(plan.voting.map((s) => s.regionId)).toEqual([3]);
  });

  it("always gives the local region a config entry, probe or no probe", async () => {
    registry.register(agent({ id: 2, region_id: 3 }), vi.fn(), vi.fn());
    fake.getProbeTargetsForMonitor.mockResolvedValue([target({ agent_id: 2, region_id: 3 })]);

    const plan = await planProbeExecution(monitor());
    // Either the server checks locally or an agent does it on the server's
    // behalf. Local is a source in both cases, so it always needs a config.
    expect(plan.config.sources.get(LOCAL_REGION_ID)).toBeDefined();
  });

  it("skips an agent whose reported capabilities do not include the type", async () => {
    registry.register(agent({ id: 1, region_id: 0 }), vi.fn(), vi.fn());
    const connection = registry.getConnection(1);
    if (connection) connection.agent = { ...connection.agent, capabilities: JSON.stringify(["PING"]) };
    fake.getProbeTargetsForMonitor.mockResolvedValue([target({ agent_id: 1, region_id: 0 })]);

    // An old agent must never be handed a check it does not implement. The
    // server's list alone would have allowed this one.
    const plan = await planProbeExecution(monitor({ monitor_type: "API" }));
    expect(plan.localSlot).toBeNull();
  });

  it("falls back to the server's list when capabilities are absent or corrupt", async () => {
    registry.register(agent({ id: 1, region_id: 0 }), vi.fn(), vi.fn());
    const connection = registry.getConnection(1);
    if (connection) connection.agent = { ...connection.agent, capabilities: "not json" };
    fake.getProbeTargetsForMonitor.mockResolvedValue([target({ agent_id: 1, region_id: 0 })]);

    const plan = await planProbeExecution(monitor());
    expect(plan.localSlot?.connection.agent.id).toBe(1);
  });

  it("checks locally when the assignment lookup fails", async () => {
    registry.register(agent({ id: 1, region_id: 0 }), vi.fn(), vi.fn());
    fake.getProbeTargetsForMonitor.mockRejectedValue(new Error("database is down"));

    // A failure to read the assignment table must never stop a check running.
    const plan = await planProbeExecution(monitor());
    expect(plan.voting).toEqual([]);
    expect(plan.localSlot).toBeNull();
  });

  it("uses the shipped defaults when the cascade itself cannot be read", async () => {
    registry.register(agent({ id: 2, region_id: 3 }), vi.fn(), vi.fn());
    fake.getProbeTargetsForMonitor.mockResolvedValue([target({ agent_id: 2, region_id: 3 })]);
    fake.getMergeRegions.mockRejectedValue(new Error("database is down"));

    // Degrading to the defaults keeps the monitor checked. Refusing to plan
    // would stop it being checked at all because a settings table was unwell.
    const plan = await planProbeExecution(monitor());
    expect(plan.config.policy).toBe("WEIGHTED_MAJORITY");
    expect(plan.voting.map((s) => s.regionId)).toEqual([3]);
  });
});

describe("runOnProbe", () => {
  it("resolves with the probe's result when it answers", async () => {
    const send = vi.fn();
    const registered = registry.register(agent({ region_id: 0 }), send, vi.fn());
    if (!registered.ok) throw new Error("register failed");

    const pending = runOnProbe(registered.connection, monitor(), 100);

    const [assignmentId] = [...registered.connection.pending.keys()];
    registered.connection.pending.get(assignmentId)?.resolve({
      kind: "result",
      result: { status: "UP", latency: 12, type: "REALTIME" },
    });

    await expect(pending).resolves.toEqual({ status: "UP", latency: 12, type: "REALTIME" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("resolves null when the probe rejects, so the caller checks locally", async () => {
    const registered = registry.register(agent({ region_id: 0 }), vi.fn(), vi.fn());
    if (!registered.ok) throw new Error("register failed");

    const pending = runOnProbe(registered.connection, monitor(), 100);
    const [id] = [...registered.connection.pending.keys()];
    registered.connection.pending.get(id)?.resolve({ kind: "reject", reason: "unsupported" });

    await expect(pending).resolves.toBeNull();
  });

  it("resolves null as soon as the connection drops, without waiting for the timeout", async () => {
    const registered = registry.register(agent({ id: 1, region_id: 0 }), vi.fn(), vi.fn());
    if (!registered.ok) throw new Error("register failed");

    const pending = runOnProbe(registered.connection, monitor(), 100);
    registry.unregister(1, "socket closed");

    // The monitor's timeout is 1000ms + slack. If this waited for it, the whole
    // point of failing pending work on unregister would be lost.
    await expect(pending).resolves.toBeNull();
  });

  it("resolves null on timeout", async () => {
    vi.useFakeTimers();
    try {
      const registered = registry.register(agent({ region_id: 0 }), vi.fn(), vi.fn());
      if (!registered.ok) throw new Error("register failed");

      const pending = runOnProbe(registered.connection, monitor({ type_data: { timeout: 50 } as never }), 100);
      await vi.advanceTimersByTimeAsync(50 + 5_000 + 1);

      await expect(pending).resolves.toBeNull();
      // And it stops owing the connection anything, so a late answer cannot
      // resolve a promise nobody is holding.
      expect(registered.connection.pending.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records the tag and minute the SERVER chose, not what the probe may echo", async () => {
    const registered = registry.register(agent({ region_id: 0 }), vi.fn(), vi.fn());
    if (!registered.ok) throw new Error("register failed");

    void runOnProbe(registered.connection, monitor({ tag: "api" }), 12345);

    const [id] = [...registered.connection.pending.keys()];
    const pending = registered.connection.pending.get(id);
    expect(pending?.monitor_tag).toBe("api");
    expect(pending?.ts).toBe(12345);
  });
});

describe("dispatchSample", () => {
  it("sends the assignment and does not block on an answer", () => {
    const send = vi.fn();
    const registered = registry.register(agent({ region_id: 3 }), send, vi.fn());
    if (!registered.ok) throw new Error("register failed");

    dispatchSample(registered.connection, monitor(), 100);

    expect(send).toHaveBeenCalledOnce();
    const frame = JSON.parse(send.mock.calls[0][0] as string);
    expect(frame).toMatchObject({ type: "assign", monitor_tag: "api", ts: 100 });
    // Registered so a result can be matched back to the minute it belongs to.
    expect(registered.connection.pending.size).toBe(1);
  });

  it("sends type_data with secrets already resolved", () => {
    process.env.KENER_DISPATCH_TEST_SECRET = "resolved";
    try {
      const send = vi.fn();
      const registered = registry.register(agent({ region_id: 3 }), send, vi.fn());
      if (!registered.ok) throw new Error("register failed");

      dispatchSample(
        registered.connection,
        monitor({ type_data: { url: "https://example.com/$KENER_DISPATCH_TEST_SECRET" } as never }),
        100,
      );

      const frame = JSON.parse(send.mock.calls[0][0] as string);
      // The probe resolves secrets against its own environment, which does not
      // hold Kener's. Sending the token unresolved would produce a check against
      // a literal "$KENER_..." URL and a DOWN nothing would explain.
      expect(frame.type_data.url).toBe("https://example.com/resolved");
    } finally {
      delete process.env.KENER_DISPATCH_TEST_SECRET;
    }
  });
});
