import { describe, it, expect, beforeEach, vi } from "vitest";

// Who writes the audit row: this middleware, or the audit consumer on the bus.
//
// Getting this wrong is expensive in both directions and neither failure is
// loud. Standing down when the bus is not carrying the change loses the audit
// row entirely. Writing anyway when it is carrying the change logs every
// dashboard action twice, once under the action name and once under the event
// type, and an audit log that double-counts is evidence of nothing.
//
// The decision is made from an observation - the ids of events actually emitted
// under the handler - rather than from a list of actions known to emit. A list
// would have to include every action whose handler reaches an emitting
// controller several layers down, and nothing would notice it going stale.

const record = vi.fn();
vi.mock("$lib/server/audit/writer.js", () => ({ record: (row: unknown) => record(row) }));

const { auditWrite } = await import("./audit.js");
import type { AuditRecord } from "./audit.js";

function auditRecord(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    action: "createIncident",
    permission: "incidents.write",
    requestId: "req-1",
    actorId: 9,
    actorLabel: "someone@example.com",
    ip: "10.0.0.1",
    userAgent: "vitest",
    targetType: "incident",
    before: undefined,
    ...over,
  };
}

beforeEach(() => record.mockClear());

describe("audit row ownership", () => {
  it("writes the row when the action put nothing on the bus", () => {
    auditWrite(auditRecord(), { id: 4 }, null, "ok", 200, []);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      action: "createIncident",
      actor_type: "user",
      request_id: "req-1",
      outcome: "ok",
      status_code: 200,
    });
  });

  it("stands down when the action emitted an event", () => {
    // The audit consumer writes this one, from the event, so that the same
    // change made through the dashboard, the v4 API and the alerting queue lands
    // in the log once and under one name.
    auditWrite(auditRecord(), { id: 4 }, null, "ok", 200, ["01EVENT"]);
    expect(record).not.toHaveBeenCalled();
  });

  it("still writes when an action was not audited at all", () => {
    // A null record means the action opted out or is a read. Nothing to write
    // and nothing to hand over.
    auditWrite(null, {}, null, "ok", 200, []);
    expect(record).not.toHaveBeenCalled();
  });

  it("carries the diff onto the row it does write", () => {
    auditWrite(
      auditRecord({ snapshot: async () => ({}) }),
      { id: 4 },
      { before: { status: "ACTIVE" }, after: { status: "INACTIVE" } },
      "ok",
      200,
      [],
    );
    const row = record.mock.calls[0][0];
    expect(JSON.parse(row.before_json)).toEqual({ status: "ACTIVE" });
    expect(JSON.parse(row.after_json)).toEqual({ status: "INACTIVE" });
    // A snapshot was taken, so the redacted payload is not also stored.
    expect(row.meta_json).toBeNull();
  });

  it("keeps the redacted payload when there was no snapshot", () => {
    auditWrite(auditRecord(), { id: 4, tag: "api" }, null, "ok", 200, []);
    expect(JSON.parse(record.mock.calls[0][0].meta_json)).toMatchObject({ id: 4, tag: "api" });
  });

  it("never throws, whatever the writer does", () => {
    // Auditing must not be able to fail a request that already succeeded.
    record.mockImplementationOnce(() => {
      throw new Error("buffer exploded");
    });
    expect(() => auditWrite(auditRecord(), { id: 4 }, null, "ok", 200, [])).not.toThrow();
  });
});
