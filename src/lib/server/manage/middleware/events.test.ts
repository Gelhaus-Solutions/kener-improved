import { describe, it, expect } from "vitest";
import { resolveActionEventType, mappedActionEvents } from "./events.js";
import { isEventType } from "$lib/event-taxonomy.js";

describe("admin action to event mapping", () => {
  it("only ever produces types in the closed taxonomy", () => {
    for (const action of mappedActionEvents()) {
      // Both branches of every resolver, plus the no-diff case.
      for (const data of [{}, { id: 1 }]) {
        for (const diff of [null, { before: { status: "ACTIVE" }, after: { status: "INACTIVE" } }]) {
          const type = resolveActionEventType(action, data, diff);
          if (type !== null) expect(isEventType(type), `${action} -> ${type}`).toBe(true);
        }
      }
    }
  });

  it("returns null for an action with no event", () => {
    expect(resolveActionEventType("getMonitors", {}, null)).toBeNull();
    expect(resolveActionEventType("nonsense", {}, null)).toBeNull();
  });

  /**
   * The double-emit guard. Incidents and maintenances emit from their
   * controllers, inside the transaction that makes the change. If one of their
   * actions were ever added to this map it would emit a second time from the
   * pipeline, and a subscriber would be notified twice about one incident.
   */
  it("never maps an action whose controller already emits", () => {
    for (const action of mappedActionEvents()) {
      const type = resolveActionEventType(action, { id: 1 }, null);
      expect(type?.startsWith("incident."), action).not.toBe(true);
      expect(type?.startsWith("maintenance."), action).not.toBe(true);
    }
  });

  it("tells a create from an edit on the upsert actions", () => {
    expect(resolveActionEventType("storeMonitorData", {}, null)).toBe("monitor.created");
    expect(resolveActionEventType("storeMonitorData", { id: 7 }, null)).toBe("monitor.updated");
    expect(resolveActionEventType("createUpdateTrigger", {}, null)).toBe("trigger.created");
    expect(resolveActionEventType("createUpdateTrigger", { id: 3 }, null)).toBe("trigger.updated");
  });

  it("reports a monitor status flip as pause or resume, not a generic update", () => {
    const paused = { before: { status: "ACTIVE" }, after: { status: "INACTIVE" } };
    const resumed = { before: { status: "INACTIVE" }, after: { status: "ACTIVE" } };
    expect(resolveActionEventType("storeMonitorData", { id: 7 }, paused)).toBe("monitor.paused");
    expect(resolveActionEventType("storeMonitorData", { id: 7 }, resumed)).toBe("monitor.resumed");
    // A change that left the status alone is still just an edit.
    expect(resolveActionEventType("storeMonitorData", { id: 7 }, { before: { name: "a" }, after: { name: "b" } })).toBe(
      "monitor.updated",
    );
  });
});
