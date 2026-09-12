import { describe, it, expect } from "vitest";
import { parseInboundPayload } from "./parsers.js";
import { INBOUND_PROVIDERS } from "./types.js";

/**
 * H1's parsers, against payloads shaped like the ones each provider really
 * sends.
 *
 * **The fingerprint assertions are the ones that matter.** Everything else here
 * is presentation, and a wrong title is a cosmetic bug somebody reports. A
 * fingerprint that changes between two notifications about one problem opens a
 * second incident, and then a third, on the public status page. That failure is
 * loud, is visible to an operator's customers, and is exactly what this feature
 * exists to prevent, so it is tested as a property - re-notify and get the same
 * value - rather than by asserting a literal hash nobody can check by eye.
 */

const alertmanagerFiring = {
  version: "4",
  status: "firing",
  alerts: [
    {
      status: "firing",
      labels: { alertname: "HighLatency", severity: "critical", service: "checkout" },
      annotations: { summary: "Checkout p99 above 2s", description: "p99 has exceeded 2s for 10 minutes" },
      startsAt: "2026-09-12T10:00:00.000Z",
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: "a1b2c3d4e5f60718",
    },
  ],
};

describe("parseInboundPayload: Alertmanager", () => {
  it("reads one alert out of a group notification", () => {
    const [alert] = parseInboundPayload("ALERTMANAGER", alertmanagerFiring);
    expect(alert).toMatchObject({
      fingerprint: "a1b2c3d4e5f60718",
      status: "FIRING",
      severity: "critical",
      title: "Checkout p99 above 2s",
      description: "p99 has exceeded 2s for 10 minutes",
    });
    expect(alert.labels.service).toBe("checkout");
    expect(alert.startsAt).toBe(Math.floor(Date.parse("2026-09-12T10:00:00.000Z") / 1000));
  });

  it("keeps a partially resolved group's members apart", () => {
    // The group's own `status` is a summary and says "firing" here. Reading it
    // instead of each alert's own would leave the resolved member open for ever.
    const alerts = parseInboundPayload("ALERTMANAGER", {
      status: "firing",
      alerts: [
        { status: "firing", labels: { alertname: "A" }, fingerprint: "aaa" },
        { status: "resolved", labels: { alertname: "B" }, fingerprint: "bbb" },
      ],
    });
    expect(alerts.map((a) => [a.fingerprint, a.status])).toEqual([
      ["aaa", "FIRING"],
      ["bbb", "RESOLVED"],
    ]);
  });

  it("gives the same fingerprint to a re-notification of one alert", () => {
    // Alertmanager re-sends every `repeat_interval` for as long as the alert
    // fires. This is the property the incident count depends on.
    const first = parseInboundPayload("ALERTMANAGER", alertmanagerFiring);
    const later = parseInboundPayload("ALERTMANAGER", {
      ...alertmanagerFiring,
      alerts: [{ ...alertmanagerFiring.alerts[0], startsAt: "2026-09-12T10:30:00.000Z" }],
    });
    expect(later[0].fingerprint).toBe(first[0].fingerprint);
  });

  it("derives a stable fingerprint when the sender supplies none", () => {
    // Older Alertmanager omits it. The derived value must not depend on the
    // order the labels happened to serialise in.
    const a = parseInboundPayload("ALERTMANAGER", {
      alerts: [{ status: "firing", labels: { alertname: "X", severity: "warning", service: "api" } }],
    });
    const b = parseInboundPayload("ALERTMANAGER", {
      alerts: [{ status: "firing", labels: { service: "api", alertname: "X", severity: "warning" } }],
    });
    expect(a[0].fingerprint).toBe(b[0].fingerprint);
    expect(a[0].fingerprint.length).toBeGreaterThan(0);
  });

  it("gives different alerts different fingerprints", () => {
    const [x] = parseInboundPayload("ALERTMANAGER", {
      alerts: [{ status: "firing", labels: { alertname: "X", service: "api" } }],
    });
    const [y] = parseInboundPayload("ALERTMANAGER", {
      alerts: [{ status: "firing", labels: { alertname: "Y", service: "api" } }],
    });
    expect(x.fingerprint).not.toBe(y.fingerprint);
  });

  it("treats Alertmanager's zero end time as absent rather than year one", () => {
    const [alert] = parseInboundPayload("ALERTMANAGER", {
      alerts: [{ status: "firing", labels: { alertname: "X" }, startsAt: "0001-01-01T00:00:00Z" }],
    });
    expect(alert.startsAt).toBeNull();
  });

  it("accepts an empty group without complaining", () => {
    // A real Alertmanager notification, not an error: rejecting it would fill
    // the endpoint's error log with correct requests.
    expect(parseInboundPayload("ALERTMANAGER", { status: "firing", alerts: [] })).toEqual([]);
  });

  it("reads Grafana through the same contract", () => {
    const [alert] = parseInboundPayload("GRAFANA", alertmanagerFiring);
    expect(alert.fingerprint).toBe("a1b2c3d4e5f60718");
    expect(alert.status).toBe("FIRING");
  });
});

describe("parseInboundPayload: Sentry", () => {
  it("reads the modern integration payload", () => {
    const [alert] = parseInboundPayload("SENTRY", {
      action: "created",
      data: { issue: { id: "4509", title: "TypeError: undefined is not a function", level: "error", project: "web" } },
    });
    expect(alert.status).toBe("FIRING");
    expect(alert.title).toBe("TypeError: undefined is not a function");
    expect(alert.labels.project).toBe("web");
    expect(alert.severity).toBe("error");
  });

  it("reads the legacy root-level payload", () => {
    const [alert] = parseInboundPayload("SENTRY", {
      id: "4509",
      message: "TypeError: undefined is not a function",
      level: "error",
      project: "web",
    });
    expect(alert.title).toBe("TypeError: undefined is not a function");
    expect(alert.labels.project).toBe("web");
  });

  it("gives one issue one fingerprint across both payload shapes", () => {
    // The same Sentry issue must not open two incidents because the operator's
    // Sentry sends a different shape than the one we happened to test first.
    const modern = parseInboundPayload("SENTRY", { action: "created", data: { issue: { id: "4509", title: "T" } } });
    const legacy = parseInboundPayload("SENTRY", { id: "4509", message: "T" });
    expect(modern[0].fingerprint).toBe(legacy[0].fingerprint);
  });

  it("treats resolved and ignored as cleared", () => {
    for (const action of ["resolved", "ignored"]) {
      const [alert] = parseInboundPayload("SENTRY", { action, data: { issue: { id: "1", title: "T" } } });
      expect(alert.status).toBe("RESOLVED");
    }
  });
});

describe("parseInboundPayload: CloudWatch", () => {
  const alarm = {
    AlarmName: "checkout-5xx",
    AlarmArn: "arn:aws:cloudwatch:eu-west-1:1:alarm:checkout-5xx",
    NewStateValue: "ALARM",
    NewStateReason: "Threshold Crossed",
    StateChangeTime: "2026-09-12T10:00:00.000+0000",
    Region: "EU (Ireland)",
    Trigger: { Namespace: "AWS/ApplicationELB" },
  };

  it("unwraps the SNS envelope", () => {
    const [alert] = parseInboundPayload("CLOUDWATCH", {
      Type: "Notification",
      Subject: "ALARM: checkout-5xx",
      Message: JSON.stringify(alarm),
    });
    expect(alert.status).toBe("FIRING");
    expect(alert.title).toBe("checkout-5xx");
    expect(alert.labels.namespace).toBe("AWS/ApplicationELB");
  });

  it("accepts a raw-delivery subscription too", () => {
    const [alert] = parseInboundPayload("CLOUDWATCH", alarm);
    expect(alert.title).toBe("checkout-5xx");
  });

  it("fingerprints an alarm the same wrapped or raw", () => {
    const wrapped = parseInboundPayload("CLOUDWATCH", { Type: "Notification", Message: JSON.stringify(alarm) });
    const raw = parseInboundPayload("CLOUDWATCH", alarm);
    expect(wrapped[0].fingerprint).toBe(raw[0].fingerprint);
  });

  it("resolves on OK and keeps firing on INSUFFICIENT_DATA", () => {
    // Monitoring going blind is not recovery. Telling the public a service
    // recovered because the alarm lost its data would be the worse error.
    const ok = parseInboundPayload("CLOUDWATCH", { ...alarm, NewStateValue: "OK" });
    expect(ok[0].status).toBe("RESOLVED");
    const blind = parseInboundPayload("CLOUDWATCH", { ...alarm, NewStateValue: "INSUFFICIENT_DATA" });
    expect(blind[0].status).toBe("FIRING");
  });

  it("reports a non-JSON SNS message rather than dropping it", () => {
    const [alert] = parseInboundPayload("CLOUDWATCH", {
      Type: "Notification",
      Subject: "Something happened",
      Message: "this is not json",
    });
    expect(alert.title).toBe("Something happened");
    expect(alert.description).toBe("this is not json");
  });
});

describe("parseInboundPayload: Uptime Kuma", () => {
  const down = {
    heartbeat: { monitorID: 7, status: 0, msg: "connect ECONNREFUSED", time: "2026-09-12 10:00:00" },
    monitor: { id: 7, name: "checkout", url: "https://example.com" },
    msg: "[checkout] [🔴 Down] connect ECONNREFUSED",
  };

  it("reads a down heartbeat as firing", () => {
    const [alert] = parseInboundPayload("UPTIME_KUMA", down);
    expect(alert.status).toBe("FIRING");
    expect(alert.title).toBe("checkout");
    expect(alert.labels.url).toBe("https://example.com");
  });

  it("resolves only on up, not on pending", () => {
    const up = parseInboundPayload("UPTIME_KUMA", { ...down, heartbeat: { ...down.heartbeat, status: 1 } });
    expect(up[0].status).toBe("RESOLVED");
    const pending = parseInboundPayload("UPTIME_KUMA", { ...down, heartbeat: { ...down.heartbeat, status: 2 } });
    expect(pending[0].status).toBe("FIRING");
  });

  it("fingerprints on the monitor, so a flap updates one incident", () => {
    const first = parseInboundPayload("UPTIME_KUMA", down);
    const again = parseInboundPayload("UPTIME_KUMA", {
      ...down,
      heartbeat: { ...down.heartbeat, time: "2026-09-12 10:05:00", msg: "connect ETIMEDOUT" },
    });
    expect(again[0].fingerprint).toBe(first[0].fingerprint);
  });
});

describe("parseInboundPayload: the generic contract", () => {
  it("reads the documented shape", () => {
    const [alert] = parseInboundPayload("GENERIC", {
      id: "db-cpu",
      title: "Database CPU high",
      status: "firing",
      severity: "warning",
      description: "CPU above 90% for 5 minutes",
      labels: { service: "db" },
    });
    expect(alert).toMatchObject({ status: "FIRING", severity: "warning", title: "Database CPU high" });
    expect(alert.labels.service).toBe("db");
  });

  it("accepts the words each vendor uses for cleared", () => {
    for (const word of ["resolved", "recovered", "ok", "up", "cleared", "closed"]) {
      const [alert] = parseInboundPayload("GENERIC", { id: "x", title: "T", status: word });
      expect(alert.status, word).toBe("RESOLVED");
    }
  });

  it("treats an unrecognised status as firing", () => {
    // The safe direction: a missed resolve leaves an incident for a human to
    // close, a wrongly inferred one tells the public the outage ended.
    const [alert] = parseInboundPayload("GENERIC", { id: "x", title: "T", status: "wobbling" });
    expect(alert.status).toBe("FIRING");
  });

  it("fingerprints on the sender's id across a status change", () => {
    const firing = parseInboundPayload("GENERIC", { id: "db-cpu", title: "T", status: "firing" });
    const resolved = parseInboundPayload("GENERIC", { id: "db-cpu", title: "T", status: "resolved" });
    expect(resolved[0].fingerprint).toBe(firing[0].fingerprint);
  });
});

describe("parseInboundPayload: every provider", () => {
  it("has a parser, so the provider list and the parsers cannot drift", () => {
    for (const provider of INBOUND_PROVIDERS) {
      expect(() => parseInboundPayload(provider, {}), provider).not.toThrow();
    }
  });

  it("survives junk without throwing, because the body is a stranger's", () => {
    // These endpoints are public and unauthenticated until the token is checked,
    // so a parser that throws on a malformed body is a denial of service.
    for (const provider of INBOUND_PROVIDERS) {
      for (const junk of [null, undefined, 42, "text", [], { alerts: "not an array" }, { data: null }]) {
        expect(() => parseInboundPayload(provider, junk), `${provider} ${JSON.stringify(junk)}`).not.toThrow();
      }
    }
  });
});
