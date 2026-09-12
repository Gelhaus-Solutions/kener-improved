import { describe, it, expect, beforeEach, vi } from "vitest";
import type { InboundAlertRecord, InboundEndpointRecord } from "../db/repositories/inbound.js";

/**
 * The receiver's decision table.
 *
 * **This is the part of H1 that decides what the public sees**, and until now it
 * was covered only by live runs. Every branch answers one question: does this
 * notification open an incident, close one, or change nothing? Getting "change
 * nothing" wrong in the opening direction is an incident storm; getting it wrong
 * in the other direction is an outage nobody is told about.
 *
 * The database and the incident controller are mocked rather than stood up,
 * because what is under test is the decision, not the storage. The storage is
 * exercised for real by the schema driver and the live run.
 */

const fake = {
  findEndpointByTokenHash: vi.fn<(hash: string) => Promise<InboundEndpointRecord | undefined>>(),
  recordEndpointRequest: vi.fn(),
  getInboundAlert: vi.fn<() => Promise<InboundAlertRecord | undefined>>(),
  insertInboundAlert: vi.fn<(data: Record<string, unknown>) => Promise<number>>(),
  updateInboundAlert: vi.fn(),
  getIncidentById: vi.fn<() => Promise<{ status: string; state: string } | undefined>>(),
};

const maintenance = {
  windowsAffecting: vi.fn<() => Promise<unknown[]>>(),
  suppressesAlerts: vi.fn<(windows: unknown[]) => boolean>(),
};

const incidents = {
  CreateIncident: vi.fn<() => Promise<{ incident_id: number }>>(),
  AddIncidentMonitor: vi.fn(),
  AddIncidentComment: vi.fn(),
};

vi.mock("../db/db.js", () => ({
  default: {
    findEndpointByTokenHash: (hash: string) => fake.findEndpointByTokenHash(hash),
    recordEndpointRequest: (...args: unknown[]) => fake.recordEndpointRequest(...args),
    getInboundAlert: () => fake.getInboundAlert(),
    insertInboundAlert: (data: Record<string, unknown>) => fake.insertInboundAlert(data),
    updateInboundAlert: (...args: unknown[]) => fake.updateInboundAlert(...args),
    getIncidentById: () => fake.getIncidentById(),
  },
}));

/**
 * The cascade is mocked at its own boundary rather than through the tables it
 * reads. What is under test here is what the receiver does with the answer; how
 * that answer is reached, including the dependency walk and the per-window
 * opt-out, is `cascade.test.ts`'s job.
 */
vi.mock("../maintenance/cascade.js", () => ({
  windowsAffecting: () => maintenance.windowsAffecting(),
  suppressesAlerts: (windows: unknown[]) => maintenance.suppressesAlerts(windows),
}));

vi.mock("../controllers/incidentController.js", () => ({
  CreateIncident: () => incidents.CreateIncident(),
  AddIncidentMonitor: (...args: unknown[]) => incidents.AddIncidentMonitor(...args),
  AddIncidentComment: (...args: unknown[]) => incidents.AddIncidentComment(...args),
}));

const { receiveInboundAlert } = await import("./receive.js");

const TOKEN = "kener_inbound_test";
const AT = 1_800_000_000;

function endpoint(over: Partial<InboundEndpointRecord> = {}): InboundEndpointRecord {
  return {
    id: 1,
    org_id: 1,
    name: "am",
    provider: "ALERTMANAGER",
    token_hash: "hash",
    token_hint: "test",
    signing_secret_encrypted: null,
    signing_secret_hint: null,
    status: "ACTIVE",
    default_monitor_tag: "api",
    mapping_rules: null,
    default_impact: null,
    default_severity: null,
    auto_resolve: true,
    last_request_at: null,
    last_success_at: null,
    last_failure_at: null,
    last_error: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function existingAlert(over: Partial<InboundAlertRecord> = {}): InboundAlertRecord {
  return {
    id: 10,
    org_id: 1,
    endpoint_id: 1,
    fingerprint: "fp",
    status: "FIRING",
    monitor_tag: "api",
    incident_id: 500,
    severity: "critical",
    title: "t",
    description: null,
    labels: null,
    first_seen_at: AT - 600,
    last_seen_at: AT - 60,
    resolved_at: null,
    notification_count: 1,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const firing = { alerts: [{ status: "firing", labels: { alertname: "A" }, fingerprint: "fp" }] };
const resolved = { alerts: [{ status: "resolved", labels: { alertname: "A" }, fingerprint: "fp" }] };

beforeEach(() => {
  vi.clearAllMocks();
  fake.findEndpointByTokenHash.mockResolvedValue(endpoint());
  fake.recordEndpointRequest.mockResolvedValue(undefined);
  fake.getInboundAlert.mockResolvedValue(undefined);
  fake.insertInboundAlert.mockResolvedValue(11);
  fake.updateInboundAlert.mockResolvedValue(1);
  maintenance.windowsAffecting.mockResolvedValue([]);
  maintenance.suppressesAlerts.mockImplementation((windows) => windows.length > 0);
  fake.getIncidentById.mockResolvedValue({ status: "OPEN", state: "INVESTIGATING" });
  incidents.CreateIncident.mockResolvedValue({ incident_id: 500 });
});

describe("authentication", () => {
  it("refuses an unknown token without saying why", async () => {
    fake.findEndpointByTokenHash.mockResolvedValue(undefined);
    const result = await receiveInboundAlert(TOKEN, firing, AT);
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(incidents.CreateIncident).not.toHaveBeenCalled();
  });

  it("refuses a disabled endpoint, and says so", async () => {
    // Distinguished from an unknown token on purpose: an operator who switched
    // an endpoint off should be told that is what happened.
    fake.findEndpointByTokenHash.mockResolvedValue(endpoint({ status: "DISABLED" }));
    const result = await receiveInboundAlert(TOKEN, firing, AT);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("records the attempt even when it refuses", async () => {
    // "Nothing is arriving" and "everything arriving is rejected" are the two
    // states an operator confuses, and only this column separates them.
    fake.findEndpointByTokenHash.mockResolvedValue(endpoint({ status: "DISABLED" }));
    await receiveInboundAlert(TOKEN, firing, AT);
    expect(fake.recordEndpointRequest).toHaveBeenCalled();
  });
});

describe("a firing alert nobody has seen before", () => {
  it("opens an incident and attaches the component before commenting", async () => {
    const result = await receiveInboundAlert(TOKEN, firing, AT);
    expect(result).toMatchObject({ ok: true, opened: 1, suppressed: 0, unmapped: 0 });

    // Order matters: the comment is what notifies subscribers, and subscriber
    // scoping resolves from the attached components. Commenting first sends it
    // to nobody.
    const attachOrder = incidents.AddIncidentMonitor.mock.invocationCallOrder[0];
    const commentOrder = incidents.AddIncidentComment.mock.invocationCallOrder[0];
    expect(attachOrder).toBeLessThan(commentOrder);
  });

  it("records it without an incident when nothing maps it", async () => {
    fake.findEndpointByTokenHash.mockResolvedValue(endpoint({ default_monitor_tag: null }));
    const result = await receiveInboundAlert(TOKEN, firing, AT);
    expect(result).toMatchObject({ ok: true, opened: 0, unmapped: 1 });
    expect(incidents.CreateIncident).not.toHaveBeenCalled();
    // Still written down, so the screen can explain what the receiver decided.
    expect(fake.insertInboundAlert).toHaveBeenCalled();
  });
});

describe("planned maintenance", () => {
  it("records the alert and opens nothing while a window is open", async () => {
    // D4. Kener's own alerting is already frozen during maintenance by the
    // overlay; an inbound alert bypasses that path entirely, so without this it
    // would announce an outage in the middle of planned work.
    maintenance.windowsAffecting.mockResolvedValue([{ id: 1 }]);
    const result = await receiveInboundAlert(TOKEN, firing, AT);
    expect(result).toMatchObject({ ok: true, opened: 0, suppressed: 1 });
    expect(incidents.CreateIncident).not.toHaveBeenCalled();
  });

  it("leaves no incident on the row, so the window ending is not amnesia", async () => {
    maintenance.windowsAffecting.mockResolvedValue([{ id: 1 }]);
    await receiveInboundAlert(TOKEN, firing, AT);
    expect(fake.insertInboundAlert).toHaveBeenCalledWith(expect.objectContaining({ incident_id: null }));
  });

  it("opens an incident on the next notification once the window has passed", async () => {
    fake.getInboundAlert.mockResolvedValue(existingAlert({ incident_id: null, status: "FIRING" }));
    maintenance.windowsAffecting.mockResolvedValue([]);
    const result = await receiveInboundAlert(TOKEN, firing, AT);
    expect(result).toMatchObject({ ok: true, opened: 1 });
  });

  it("still closes an incident that was already open when the window started", async () => {
    // Closing is never the harmful direction, so maintenance does not block it.
    fake.getInboundAlert.mockResolvedValue(existingAlert());
    maintenance.windowsAffecting.mockResolvedValue([{ id: 1 }]);
    const result = await receiveInboundAlert(TOKEN, resolved, AT);
    expect(result).toMatchObject({ ok: true, resolved: 1 });
  });
});

describe("repeat notifications", () => {
  it("changes nothing when the alert is already open", async () => {
    // The whole feature. Alertmanager re-sends for as long as the alert fires.
    fake.getInboundAlert.mockResolvedValue(existingAlert());
    const result = await receiveInboundAlert(TOKEN, firing, AT);
    expect(result).toMatchObject({ ok: true, opened: 0, resolved: 0 });
    expect(incidents.CreateIncident).not.toHaveBeenCalled();
  });

  it("counts the notification even when it changes nothing", async () => {
    fake.getInboundAlert.mockResolvedValue(existingAlert({ notification_count: 4 }));
    await receiveInboundAlert(TOKEN, firing, AT);
    expect(fake.updateInboundAlert).toHaveBeenCalledWith(10, expect.objectContaining({ notification_count: 5 }));
  });
});

describe("resolving", () => {
  it("closes the incident the alert opened", async () => {
    fake.getInboundAlert.mockResolvedValue(existingAlert());
    const result = await receiveInboundAlert(TOKEN, resolved, AT);
    expect(result).toMatchObject({ ok: true, resolved: 1 });
    expect(incidents.AddIncidentComment).toHaveBeenCalledWith(500, expect.any(String), "RESOLVED", AT);
  });

  it("does not close twice when the sender repeats itself", async () => {
    fake.getInboundAlert.mockResolvedValue(existingAlert({ status: "RESOLVED", resolved_at: AT - 60 }));
    const result = await receiveInboundAlert(TOKEN, resolved, AT);
    expect(result).toMatchObject({ ok: true, resolved: 0 });
    expect(incidents.AddIncidentComment).not.toHaveBeenCalled();
  });

  it("leaves an incident a human already resolved alone", async () => {
    fake.getInboundAlert.mockResolvedValue(existingAlert());
    fake.getIncidentById.mockResolvedValue({ status: "OPEN", state: "RESOLVED" });
    const result = await receiveInboundAlert(TOKEN, resolved, AT);
    expect(result).toMatchObject({ ok: true, resolved: 0 });
    expect(incidents.AddIncidentComment).not.toHaveBeenCalled();
  });

  it("respects an endpoint that never closes incidents", async () => {
    fake.findEndpointByTokenHash.mockResolvedValue(endpoint({ auto_resolve: false }));
    fake.getInboundAlert.mockResolvedValue(existingAlert());
    const result = await receiveInboundAlert(TOKEN, resolved, AT);
    expect(result).toMatchObject({ ok: true, resolved: 0 });
    expect(incidents.AddIncidentComment).not.toHaveBeenCalled();
  });

  it("records a resolve for an alert it never saw fire, without inventing an incident", async () => {
    // A phantom outage in the public history would be worse than a missing row.
    const result = await receiveInboundAlert(TOKEN, resolved, AT);
    expect(result).toMatchObject({ ok: true, opened: 0, resolved: 0 });
    expect(incidents.CreateIncident).not.toHaveBeenCalled();
    expect(fake.insertInboundAlert).toHaveBeenCalled();
  });
});

describe("firing again after a resolve", () => {
  it("opens a new incident rather than reopening the old one", async () => {
    // It is a new outage. The closed incident's history belongs to the earlier
    // event and must not be rewritten.
    fake.getInboundAlert.mockResolvedValue(existingAlert({ status: "RESOLVED", resolved_at: AT - 600 }));
    const result = await receiveInboundAlert(TOKEN, firing, AT);
    expect(result).toMatchObject({ ok: true, opened: 1 });
    expect(incidents.CreateIncident).toHaveBeenCalled();
  });
});

describe("a batch", () => {
  it("keeps going when one alert in the group fails", async () => {
    // Alertmanager sends a whole group at once. Failing the request would make
    // it retry the ones that already succeeded.
    incidents.CreateIncident.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ incident_id: 501 });
    const result = await receiveInboundAlert(
      TOKEN,
      {
        alerts: [
          { status: "firing", labels: { alertname: "A" }, fingerprint: "one" },
          { status: "firing", labels: { alertname: "B" }, fingerprint: "two" },
        ],
      },
      AT,
    );
    expect(result).toMatchObject({ ok: true, accepted: 2, opened: 1 });
  });

  it("accepts a notification carrying no alerts at all", async () => {
    const result = await receiveInboundAlert(TOKEN, { status: "firing", alerts: [] }, AT);
    expect(result).toMatchObject({ ok: true, accepted: 0, opened: 0 });
  });
});
