import { describe, it, expect } from "vitest";
import { diffEvent, isBlocking, SHADOW_PAIRS, BLOCKING_VERDICTS } from "./shadowDiff.js";
import type { EventDeliveryRecord } from "./types.js";

// The verdict logic is the part of H8c that a wrong answer would be most costly
// in: it is the evidence the P6 cutover is decided on, and a diff that quietly
// reports MATCH for a dropped recipient would authorise exactly the silent
// notification loss the shadow period exists to prevent.

function delivery(over: Partial<EventDeliveryRecord>): EventDeliveryRecord {
  return {
    id: 1,
    event_id: "01EVENT",
    org_id: 1,
    consumer: "subscribers",
    target_type: "subscriber_method",
    target_id: "7",
    status: "SHADOW",
    attempts: 1,
    next_attempt_at: null,
    last_attempt_at: 100,
    response_code: null,
    response_body: null,
    error: null,
    request_headers: null,
    request_body: null,
    duration_ms: null,
    created_at: 100,
    updated_at: 100,
    ...over,
  };
}

/** A rendered subscriber email, in the shape both sides actually store. */
function email(over: { to?: string; subject?: string; text?: string; siteTitle?: string } = {}): string {
  return JSON.stringify({
    toEmails: [over.to ?? "a@example.com"],
    templateHtmlBody: "<p>{{update_text}}</p>",
    templateSubject: "Update",
    templateTextBody: "",
    variables: {
      // A site variable, which legitimately differs between the two renders and
      // must never be treated as a difference.
      site_name: over.siteTitle ?? "Kener",
      title: "Database outage",
      update_subject: over.subject ?? "[#4:INVESTIGATING] Database outage",
      update_text: over.text ?? "<p>Looking into it.</p>",
      update_id: "9",
      cta_url: "https://status.example.com/incidents/4",
      event_type: "incidents",
    },
  });
}

const base = {
  event_id: "01EVENT",
  event_type: "incident.comment_added",
  occurred_at: 1000,
  consumer: "subscribers",
  legacy_consumer: "email",
};

describe("shadow diff verdicts", () => {
  it("calls an identical message a match", () => {
    const rows = diffEvent({
      ...base,
      shadow: [delivery({ request_body: email() })],
      live: [delivery({ consumer: "email", status: "DELIVERED", request_body: email() })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("MATCH");
  });

  it("ignores site variables that merely re-rendered", () => {
    // The two sides render at different moments, so anything read from site
    // configuration can differ for reasons that have nothing to do with the bus.
    // Reporting those would make the diff cry wolf and get it ignored.
    const rows = diffEvent({
      ...base,
      shadow: [delivery({ request_body: email({ siteTitle: "Kener" }) })],
      live: [delivery({ consumer: "email", request_body: email({ siteTitle: "Renamed Status Page" }) })],
    });
    expect(rows[0].verdict).toBe("MATCH");
  });

  it("reports the fields that actually differ", () => {
    const rows = diffEvent({
      ...base,
      shadow: [delivery({ request_body: email({ text: "<p>Different wording.</p>" }) })],
      live: [delivery({ consumer: "email", request_body: email() })],
    });
    expect(rows[0].verdict).toBe("BODY_DIFFERS");
    expect(rows[0].differing_fields).toEqual(["update_text"]);
  });

  it("flags a recipient the rehearsal would have missed", () => {
    // The one finding that must block a cutover: the old path mailed somebody
    // the new path never resolved, so flipping would drop that notification.
    const rows = diffEvent({
      ...base,
      shadow: [],
      live: [delivery({ consumer: "email", target_id: "7", request_body: email() })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("MISSING_SHADOW");
    expect(isBlocking(rows[0].verdict)).toBe(true);
  });

  it("distinguishes an over-send from a dropped message", () => {
    const rows = diffEvent({
      ...base,
      shadow: [delivery({ target_id: "7", request_body: email() })],
      live: [],
    });
    expect(rows[0].verdict).toBe("MISSING_LIVE");
    // An over-send is embarrassing, not harmful, and must not stop the cutover.
    expect(isBlocking(rows[0].verdict)).toBe(false);
  });

  it("reports a rehearsal that could not render, ahead of comparing anything", () => {
    const rows = diffEvent({
      ...base,
      shadow: [delivery({ error: "Could not rebuild the notification", request_body: null })],
      live: [delivery({ consumer: "email", request_body: email() })],
    });
    expect(rows[0].verdict).toBe("SHADOW_ERROR");
    expect(isBlocking(rows[0].verdict)).toBe(true);
  });

  it("claims presence only when the legacy side stores no body", () => {
    // Triggers, by design: the live sender substitutes environment secrets
    // before rendering, so its body is deliberately never stored.
    const rows = diffEvent({
      ...base,
      consumer: "triggers",
      legacy_consumer: "alert_trigger",
      event_type: "monitor.alert_triggered",
      shadow: [delivery({ consumer: "triggers", target_type: "trigger", target_id: "3", request_body: "{}" })],
      live: [
        delivery({
          consumer: "alert_trigger",
          target_type: "trigger",
          target_id: "3",
          status: "DELIVERED",
          request_body: null,
        }),
      ],
    });
    expect(rows[0].verdict).toBe("PRESENCE_ONLY");
    expect(isBlocking(rows[0].verdict)).toBe(false);
  });

  it("pairs every recipient of a fan-out independently", () => {
    const rows = diffEvent({
      ...base,
      shadow: [
        delivery({ target_id: "1", request_body: email({ to: "one@example.com" }) }),
        delivery({ target_id: "2", request_body: email({ to: "two@example.com" }) }),
      ],
      live: [
        delivery({ consumer: "email", target_id: "1", request_body: email({ to: "one@example.com" }) }),
        delivery({ consumer: "email", target_id: "3", request_body: email({ to: "three@example.com" }) }),
      ],
    });
    const byTarget = Object.fromEntries(rows.map((r) => [r.target_id, r.verdict]));
    expect(byTarget).toEqual({ "1": "MATCH", "2": "MISSING_LIVE", "3": "MISSING_SHADOW" });
  });

  it("never pairs a shadow consumer with itself", () => {
    // Sharing a consumer name would make the rehearsal and the real send collide
    // on the delivery UNIQUE, and one would silently overwrite the other.
    for (const [shadow, legacy] of Object.entries(SHADOW_PAIRS)) {
      expect(shadow).not.toBe(legacy);
    }
  });

  it("treats only the three real findings as blocking", () => {
    expect([...BLOCKING_VERDICTS].sort()).toEqual(["BODY_DIFFERS", "MISSING_SHADOW", "SHADOW_ERROR"]);
  });
});
