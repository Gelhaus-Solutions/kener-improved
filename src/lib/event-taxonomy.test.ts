import { describe, it, expect } from "vitest";
import {
  EVENT_TYPES,
  EVENT_AGGREGATE_TYPE,
  ADMIN_EVENTS,
  isEventType,
  isAdminEventType,
  subscribableEventTypes,
  subscribableEventsByDomain,
} from "./event-taxonomy.js";

describe("event taxonomy", () => {
  it("has no duplicates", () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it("maps every type to an aggregate, including the ones whose prefix lies", () => {
    for (const type of EVENT_TYPES) {
      expect(EVENT_AGGREGATE_TYPE[type], type).toBeTruthy();
    }
    // The two that would be wrong if the aggregate were read off the prefix.
    expect(EVENT_AGGREGATE_TYPE["role.permissions_changed"]).toBe("role");
    expect(EVENT_AGGREGATE_TYPE["maintenance.started"]).toBe("maintenance_event");
    expect(EVENT_AGGREGATE_TYPE["maintenance.deleted"]).toBe("maintenance");
  });

  it("names every type domain.action", () => {
    for (const type of EVENT_TYPES) expect(type, type).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it("rejects a near miss", () => {
    expect(isEventType("incident.updated")).toBe(true);
    expect(isEventType("incident.update")).toBe(false);
    expect(isEventType("")).toBe(false);
    expect(isEventType(null)).toBe(false);
  });

  it("keeps administrative events out of what a webhook can subscribe to", () => {
    const subscribable = subscribableEventTypes();
    for (const admin of ADMIN_EVENTS) {
      expect(subscribable, admin).not.toContain(admin);
      expect(isAdminEventType(admin)).toBe(true);
    }
    // Configuration changes are the operator's business, not a third party's.
    expect(subscribable).not.toContain("user.created");
    expect(subscribable).not.toContain("apikey.created");
    expect(subscribable).toContain("incident.resolved");
    expect(subscribable.length + ADMIN_EVENTS.length).toBe(EVENT_TYPES.length);
  });

  it("groups the picker by domain without losing anything", () => {
    const grouped = subscribableEventsByDomain();
    expect(grouped.flatMap((g) => g.types).sort()).toEqual([...subscribableEventTypes()].sort());
    expect(grouped.map((g) => g.domain)).toContain("incident");
    expect(grouped.map((g) => g.domain)).not.toContain("user");
  });
});
