import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MonitorRecordTyped } from "../types/db.js";
import type { ProbeAgentRecord, ProbeTarget } from "../db/repositories/probes.js";

const fake = {
  getProbeTargetsForMonitor: vi.fn<(tag: string) => Promise<ProbeTarget[]>>(),
};

vi.mock("../db/db.js", () => ({
  default: {
    getProbeTargetsForMonitor: (tag: string) => fake.getProbeTargetsForMonitor(tag),
  },
}));

const { planProbeExecution, runOnProbe, dispatchSample, isProbeEligible } = await import("./dispatch.js");
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
  fake.getProbeTargetsForMonitor.mockReset();
  fake.getProbeTargetsForMonitor.mockResolvedValue([]);
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
    expect(plan).toEqual({ merged: null, samples: [] });
    // The overwhelming majority of checks take this path, so it has to cost
    // nothing. A query here would be one per monitor per minute, forever.
    expect(fake.getProbeTargetsForMonitor).not.toHaveBeenCalled();
  });

  it("returns an empty plan when the assigned agent is not connected", async () => {
    fake.getProbeTargetsForMonitor.mockResolvedValue([target()]);
    // Nothing registered: the agent has an assignment but no live socket.
    const plan = await planProbeExecution(monitor());
    expect(plan).toEqual({ merged: null, samples: [] });
  });

  it("puts a region 0 agent in `merged` and a region >= 1 agent in `samples`", async () => {
    registry.register(agent({ id: 1, region_id: 0 }), vi.fn(), vi.fn());
    registry.register(agent({ id: 2, region_id: 3 }), vi.fn(), vi.fn());
    fake.getProbeTargetsForMonitor.mockResolvedValue([
      target({ agent_id: 1, region_id: 0 }),
      target({ assignment_id: 2, agent_id: 2, region_id: 3 }),
    ]);

    const plan = await planProbeExecution(monitor());

    // This split is the whole rule: region 0 is the verdict and replaces the
    // local check, everything else is an extra sample alongside it.
    expect(plan.merged?.agent.id).toBe(1);
    expect(plan.samples.map((c) => c.agent.id)).toEqual([2]);
  });

  it("skips an agent whose reported capabilities do not include the type", async () => {
    registry.register(agent({ id: 1, region_id: 0 }), vi.fn(), vi.fn());
    const connection = registry.getConnection(1);
    if (connection) connection.agent = { ...connection.agent, capabilities: JSON.stringify(["PING"]) };
    fake.getProbeTargetsForMonitor.mockResolvedValue([target({ agent_id: 1, region_id: 0 })]);

    // An old agent must never be handed a check it does not implement. The
    // server's list alone would have allowed this one.
    const plan = await planProbeExecution(monitor({ monitor_type: "API" }));
    expect(plan.merged).toBeNull();
  });

  it("falls back to the server's list when capabilities are absent or corrupt", async () => {
    registry.register(agent({ id: 1, region_id: 0 }), vi.fn(), vi.fn());
    const connection = registry.getConnection(1);
    if (connection) connection.agent = { ...connection.agent, capabilities: "not json" };
    fake.getProbeTargetsForMonitor.mockResolvedValue([target({ agent_id: 1, region_id: 0 })]);

    const plan = await planProbeExecution(monitor());
    expect(plan.merged?.agent.id).toBe(1);
  });

  it("checks locally when the assignment lookup fails", async () => {
    registry.register(agent({ id: 1, region_id: 0 }), vi.fn(), vi.fn());
    fake.getProbeTargetsForMonitor.mockRejectedValue(new Error("database is down"));

    // A failure to read the assignment table must never stop a check running.
    const plan = await planProbeExecution(monitor());
    expect(plan).toEqual({ merged: null, samples: [] });
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
