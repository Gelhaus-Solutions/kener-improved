import { describe, it, expect } from "vitest";
import { shouldAudit, auditConsumer } from "./audit.js";
import { EVENT_TYPES } from "$lib/event-taxonomy.js";
import type { OutboxEvent } from "../types.js";

// What the audit consumer will and will not write a row for.
//
// Both directions cost something real if they are wrong. Auditing too little
// leaves a change nobody can account for; auditing `monitor.status_changed`
// would put hundreds of thousands of rows a day into the log and bury the ones
// somebody is looking for.

function event(over: Partial<OutboxEvent>): OutboxEvent {
  return {
    id: 42,
    event_id: "01EVENT",
    org_id: 1,
    type: "incident.created",
    aggregate_type: "incident",
    aggregate_id: "4",
    actor_type: "user",
    actor_id: "9",
    actor_label: "someone@example.com",
    occurred_at: 1000,
    payload: null,
    diff: null,
    correlation_id: "req-1",
    causation_id: null,
    idempotency_key: null,
    suppress: false,
    schema_version: 1,
    claimed_at: null,
    claimed_by: null,
    published_at: null,
    ...over,
  };
}

describe("audit consumer scope", () => {
  it("audits every change a person, a key or a login caused", () => {
    for (const actor of ["user", "api_key", "oidc", "anonymous"]) {
      expect(shouldAudit(actor, "incident.created")).toBe(true);
    }
  });

  it("does not audit the per-monitor status flood", () => {
    // The reason this consumer has a system allowlist at all. A status page
    // checks hundreds of monitors a minute.
    expect(shouldAudit("system", "monitor.status_changed")).toBe(false);
  });

  it("audits the automatic actions a human would otherwise have taken", () => {
    for (const type of [
      "monitor.alert_triggered",
      "monitor.alert_resolved",
      "webhook_endpoint.disabled",
      "incident.created",
      "maintenance.started",
    ]) {
      expect(shouldAudit("system", type)).toBe(true);
    }
  });

  it("rejects a system event that is not in the taxonomy", () => {
    expect(shouldAudit("system", "made.up")).toBe(false);
  });

  it("produces exactly one delivery for an audited event and none otherwise", () => {
    // The empty target pair is load-bearing: the UNIQUE that deduplicates
    // deliveries covers target_type and target_id, and a NULL in it would not
    // deduplicate at all.
    const audited = auditConsumer.targets(event({ actor_type: "user" }));
    expect(audited).toEqual([{ target_type: "", target_id: "" }]);

    expect(auditConsumer.targets(event({ actor_type: "system", type: "monitor.status_changed" }))).toEqual([]);
  });

  it("keeps every taxonomy event decidable", () => {
    // Guards against a new event type landing in a state where nobody has
    // decided whether it is evidence. Every type must give a definite answer for
    // both a human actor and the system.
    for (const type of EVENT_TYPES) {
      expect(typeof shouldAudit("user", type)).toBe("boolean");
      expect(typeof shouldAudit("system", type)).toBe("boolean");
    }
  });

  it("does not rehearse, because it sends nothing to rehearse", () => {
    expect(auditConsumer.supportsDryRun).toBe(false);
  });
});
