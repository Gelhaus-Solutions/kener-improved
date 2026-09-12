import { describe, it, expect, beforeEach, vi } from "vitest";
import * as registry from "./registry.js";
import type { ProbeAgentRecord } from "../db/repositories/probes.js";

function agent(overrides: Partial<ProbeAgentRecord> = {}): ProbeAgentRecord {
  return {
    id: 1,
    org_id: 1,
    name: "Frankfurt",
    region_id: 3,
    weight: 1,
    token_hash: "hash",
    token_hint: "abcd",
    status: "ACTIVE",
    connection_state: "DISCONNECTED",
    agent_version: "1.0.0",
    capabilities: null,
    last_seen_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

beforeEach(() => {
  registry.clear("test reset");
});

describe("register", () => {
  it("adds a connection that can then be found by agent and by region", () => {
    const result = registry.register(agent(), vi.fn(), vi.fn());
    expect(result.ok).toBe(true);
    expect(registry.getConnection(1)).toBeDefined();
    expect(registry.connectionsForRegion(1, 3).map((c) => c.agent.id)).toEqual([1]);
  });

  it("keeps regions separate per org", () => {
    registry.register(agent({ id: 1, org_id: 1, region_id: 3 }), vi.fn(), vi.fn());
    const other = registry.register(agent({ id: 2, org_id: 2, region_id: 3 }), vi.fn(), vi.fn());

    // Two tenants each having "their Frankfurt probe" is the ordinary case, not
    // a collision. Keyed on the region alone, the second would be refused.
    expect(other.ok).toBe(true);
    expect(registry.connectionsForRegion(1, 3).map((c) => c.agent.id)).toEqual([1]);
    expect(registry.connectionsForRegion(2, 3).map((c) => c.agent.id)).toEqual([2]);
  });

  it("accepts a second agent for one region, and serves both", () => {
    registry.register(agent({ id: 2, region_id: 3 }), vi.fn(), vi.fn());
    const second = registry.register(agent({ id: 1, region_id: 3 }), vi.fn(), vi.fn());

    // Agents in a region answer for one vantage point, so a second one is
    // redundancy rather than a collision. Both are dispatched and the merge
    // reduces their answers to the single verdict the region reports.
    expect(second.ok).toBe(true);
    // Sorted by agent id, not by who connected first: TRUST_ORDER ranks agents
    // by their position in this list, so the order must not depend on network
    // luck.
    expect(registry.connectionsForRegion(1, 3).map((c) => c.agent.id)).toEqual([1, 2]);
  });

  it("replaces the same agent's previous connection and closes the old socket", () => {
    const closeOld = vi.fn();
    registry.register(agent({ id: 1 }), vi.fn(), closeOld);
    const again = registry.register(agent({ id: 1 }), vi.fn(), vi.fn());

    // A probe whose network dropped reconnects while the server still believes
    // the old socket is alive. Refusing it would leave the agent unreachable
    // until the sweeper noticed.
    expect(again.ok).toBe(true);
    expect(closeOld).toHaveBeenCalled();
    expect(registry.connectedAgentIds()).toEqual([1]);
  });

  it("leaves the region occupied after a replacement", () => {
    registry.register(agent({ id: 1, region_id: 3 }), vi.fn(), vi.fn());
    registry.register(agent({ id: 1, region_id: 3 }), vi.fn(), vi.fn());

    // The replacement path unregisters the old connection, which must not free a
    // region that is in fact still occupied by its successor.
    expect(registry.connectionsForRegion(1, 3).map((c) => c.agent.id)).toEqual([1]);
  });

  it("keeps a region served while one of its several agents goes", () => {
    registry.register(agent({ id: 1, region_id: 3 }), vi.fn(), vi.fn());
    registry.register(agent({ id: 2, region_id: 3 }), vi.fn(), vi.fn());

    registry.unregister(1, "socket closed");

    // The whole point of a second agent: losing one leaves the region answering
    // rather than falling back to a local check.
    expect(registry.connectionsForRegion(1, 3).map((c) => c.agent.id)).toEqual([2]);
  });
});

describe("unregister", () => {
  it("fails every pending assignment rather than leaving them to time out", () => {
    const registered = registry.register(agent(), vi.fn(), vi.fn());
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const resolve = vi.fn();
    registered.connection.pending.set("a-1", { monitor_tag: "api", ts: 100, recordsSample: false, resolve });

    registry.unregister(1, "socket closed");

    // This is what makes the fallback immediate. Without it a worker awaiting a
    // probe that has just gone would sit until its timeout expired.
    expect(resolve).toHaveBeenCalledWith({ kind: "gone", reason: "socket closed" });
    expect(registry.getConnection(1)).toBeUndefined();
    expect(registry.connectionsForRegion(1, 3)).toEqual([]);
  });

  it("is harmless for an agent that is not connected", () => {
    expect(registry.unregister(99, "never here")).toBeUndefined();
  });
});

describe("noteHeartbeat", () => {
  it("resets the missed count that the sweeper acts on", () => {
    const registered = registry.register(agent(), vi.fn(), vi.fn());
    if (!registered.ok) return;

    registered.connection.missedHeartbeats = 2;
    registered.connection.lastHeartbeatAt = 0;

    registry.noteHeartbeat(1);

    expect(registered.connection.missedHeartbeats).toBe(0);
    expect(registered.connection.lastHeartbeatAt).toBeGreaterThan(0);
  });
});

describe("clear", () => {
  it("empties both indexes so a restart in one process starts clean", () => {
    registry.register(agent({ id: 1, region_id: 1 }), vi.fn(), vi.fn());
    registry.register(agent({ id: 2, region_id: 2 }), vi.fn(), vi.fn());

    registry.clear("shutting down");

    expect(registry.allConnections()).toEqual([]);
    expect(registry.connectionsForRegion(1, 1)).toEqual([]);
    expect(registry.connectionsForRegion(1, 2)).toEqual([]);
  });
});
