import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signPayload, checkWebhookUrl, redactHeaders } from "./webhook_delivery.js";

describe("webhook signing", () => {
  const body = JSON.stringify({ id: "01ABC", type: "incident.created" });

  it("produces the documented header shape", () => {
    expect(signPayload(body, ["whsec_a"], 1700000000)).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  it("matches what a receiver computes from the recipe", () => {
    const t = 1700000000;
    const header = signPayload(body, ["whsec_a"], t);
    const expected = createHmac("sha256", "whsec_a").update(`${t}.${body}`).digest("hex");
    expect(header).toContain(`v1=${expected}`);
  });

  it("signs the timestamp too, so a captured body cannot be re-stamped", () => {
    const a = signPayload(body, ["whsec_a"], 1700000000);
    const b = signPayload(body, ["whsec_a"], 1700000001);
    expect(a.split("v1=")[1]).not.toBe(b.split("v1=")[1]);
  });

  it("emits one signature per active secret during a rotation", () => {
    const header = signPayload(body, ["whsec_new", "whsec_old"], 1700000000);
    const sigs = [...header.matchAll(/v1=([0-9a-f]{64})/g)];
    expect(sigs).toHaveLength(2);
    // A receiver on either secret accepts, which is what makes rotation
    // survivable without dropping a delivery.
    for (const secret of ["whsec_new", "whsec_old"]) {
      expect(header).toContain(createHmac("sha256", secret).update(`1700000000.${body}`).digest("hex"));
    }
  });

  it("skips empty secrets rather than signing with one", () => {
    const header = signPayload(body, ["whsec_a", ""], 1700000000);
    expect([...header.matchAll(/v1=/g)]).toHaveLength(1);
  });
});

describe("webhook SSRF guard", () => {
  const blocked = [
    ["http://127.0.0.1/x", "loopback"],
    ["http://127.255.255.254/x", "loopback range"],
    ["http://0.0.0.0/x", "this-network"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://10.1.2.3/x", "RFC1918 10/8"],
    ["http://172.16.0.1/x", "RFC1918 172.16/12"],
    ["http://172.31.255.255/x", "RFC1918 172.31"],
    ["http://192.168.0.1/x", "RFC1918 192.168/16"],
    ["http://100.64.0.1/x", "carrier-grade NAT"],
    ["http://[::1]/x", "IPv6 loopback"],
    ["http://[fe80::1]/x", "IPv6 link-local"],
    ["http://[fd00::1]/x", "IPv6 unique-local"],
    ["http://[::ffff:127.0.0.1]/x", "IPv4-mapped loopback"],
    ["ftp://example.com/x", "non-HTTP protocol"],
    ["file:///etc/passwd", "file protocol"],
    ["not a url", "unparseable"],
  ] as const;

  for (const [url, why] of blocked) {
    it(`rejects ${why}`, async () => {
      delete process.env.KENER_ALLOW_PRIVATE_WEBHOOKS;
      const result = await checkWebhookUrl(url);
      expect(result.allowed, url).toBe(false);
      expect(result.reason).toBeTruthy();
    });
  }

  it("allows a public literal address", async () => {
    delete process.env.KENER_ALLOW_PRIVATE_WEBHOOKS;
    expect((await checkWebhookUrl("https://93.184.216.34/hook")).allowed).toBe(true);
  });

  it("lets an operator opt in to private endpoints", async () => {
    process.env.KENER_ALLOW_PRIVATE_WEBHOOKS = "true";
    try {
      // The common legitimate case: a receiver on the same internal network.
      expect((await checkWebhookUrl("http://10.1.2.3/hook")).allowed).toBe(true);
    } finally {
      delete process.env.KENER_ALLOW_PRIVATE_WEBHOOKS;
    }
  });

  it("does not treat 172.15 or 172.32 as private", async () => {
    delete process.env.KENER_ALLOW_PRIVATE_WEBHOOKS;
    // The boundary the /12 mask makes easy to get wrong in both directions.
    expect((await checkWebhookUrl("http://172.15.0.1/x")).allowed).toBe(true);
    expect((await checkWebhookUrl("http://172.32.0.1/x")).allowed).toBe(true);
  });
});

describe("outgoing header redaction", () => {
  it("keeps the headers a reader needs", () => {
    const out = redactHeaders({
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "Kener/4.1.5",
      "kener-event-id": "01ABC",
      "kener-event-type": "incident.created",
      "kener-delivery-seq": "42",
    });
    expect(out["content-type"]).toBe("application/json");
    expect(out["kener-event-type"]).toBe("incident.created");
    expect(out["kener-delivery-seq"]).toBe("42");
  });

  it("strips the signature digest but keeps its timestamp", () => {
    const out = redactHeaders({ "kener-signature": `t=1700000000,v1=${"a".repeat(64)}` });
    // The timestamp is useful for debugging skew; the digest is an oracle.
    expect(out["kener-signature"]).toBe("t=1700000000,v1=[redacted]");
  });

  it("strips every digest during a rotation, not just the first", () => {
    const out = redactHeaders({ "kener-signature": `t=1,v1=${"a".repeat(64)},v1=${"b".repeat(64)}` });
    expect(out["kener-signature"]).toBe("t=1,v1=[redacted],v1=[redacted]");
  });

  it("redacts anything it does not recognise, because that is where tokens live", () => {
    const out = redactHeaders({
      Authorization: "Bearer super-secret",
      "X-Api-Key": "abc123",
      Cookie: "session=xyz",
    });
    expect(Object.values(out)).toEqual(["[redacted]", "[redacted]", "[redacted]"]);
    expect(JSON.stringify(out)).not.toContain("super-secret");
    expect(JSON.stringify(out)).not.toContain("abc123");
  });

  it("is case-insensitive about the safe list", () => {
    const out = redactHeaders({ "Content-Type": "application/json", "Kener-Event-Type": "incident.resolved" });
    expect(out["Content-Type"]).toBe("application/json");
    expect(out["Kener-Event-Type"]).toBe("incident.resolved");
  });
});
