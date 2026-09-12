import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import ApiCall from "./apiCall";
import type { ApiMonitor } from "../types/monitor";

vi.mock("axios", () => ({ default: vi.fn() }));
const mockedAxios = vi.mocked(axios);

beforeEach(() => {
  mockedAxios.mockReset();
  mockedAxios.mockResolvedValue({ status: 200, data: "ok" });
});

describe("ApiCall.execute", () => {
  it("does not throw in the constructor and records ERROR when type_data is null", async () => {
    // The worker constructs the service before calling execute(), so the
    // constructor must survive a malformed (null type_data) monitor and
    // execute() must record a result instead of leaving a gap in the timeline.
    const monitor = { tag: "api-test", type_data: null } as unknown as ApiMonitor;
    const r = await new ApiCall(monitor).execute();
    expect(r.status).toBe("DOWN");
    expect(r.type).toBe("ERROR");
    expect(r.error_message).toBe("API monitor is missing configuration");
  });
});

describe("ApiCall proxy", () => {
  const withEnv = (key: string, value: string) => {
    const prev = process.env[key];
    process.env[key] = value;
    return () => {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    };
  };
  let restoreEnv: (() => void) | undefined;
  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
  });

  const monitor = (overrides: Partial<NonNullable<ApiMonitor["type_data"]>> = {}): ApiMonitor =>
    ({
      tag: "api-proxy",
      type_data: { url: "https://example.com/health", method: "GET", ...overrides },
    }) as ApiMonitor;

  // axios's own env-proxy code never CONNECT-tunnels and drops httpsAgent for http:// proxies,
  // so every call must opt out of it and let Node's agents do the proxying.
  const optionsOfLastCall = () => mockedAxios.mock.calls[0][1] as Record<string, any>;

  it("routes through the monitor's own proxy, with $SECRET substituted, on both agents", async () => {
    restoreEnv = withEnv("PROXY_PASS", "pw");
    await new ApiCall(monitor({ proxy: "http://user:$PROXY_PASS@proxy.internal:3128" })).execute();
    const o = optionsOfLastCall();
    expect(o.proxy).toBe(false);
    const expected = {
      HTTPS_PROXY: "http://user:pw@proxy.internal:3128",
      HTTP_PROXY: "http://user:pw@proxy.internal:3128",
    };
    expect(o.httpsAgent.options.proxyEnv).toEqual(expected);
    expect(o.httpAgent.options.proxyEnv).toEqual(expected);
  });

  it("falls back to the process env (HTTP_PROXY / HTTPS_PROXY / NO_PROXY) without a monitor proxy", async () => {
    await new ApiCall(monitor()).execute();
    const o = optionsOfLastCall();
    expect(o.proxy).toBe(false);
    expect(o.httpsAgent.options.proxyEnv).toBe(process.env);
    expect(o.httpAgent.options.proxyEnv).toBe(process.env);
  });

  it("keeps allowSelfSignedCert on the https agent", async () => {
    await new ApiCall(monitor({ allowSelfSignedCert: true, proxy: "http://proxy.internal:3128" })).execute();
    expect(optionsOfLastCall().httpsAgent.options.rejectUnauthorized).toBe(false);
  });
});

describe("I6: a secret must not reach an unencrypted transport", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function monitorWith(type_data: Record<string, unknown>): ApiMonitor {
    return { tag: "api-test", monitor_type: "API", type_data } as unknown as ApiMonitor;
  }

  it("refuses before axios is called at all", async () => {
    // The strongest assertion available here: not "the header was absent" but
    // "the request never happened". Measured against a real listener too, where
    // the plain server recorded no hit.
    process.env.LEAKTOKEN = "s3cr3t";
    const r = await new ApiCall(
      monitorWith({
        url: "http://internal:8080/",
        method: "GET",
        headers: [{ key: "Authorization", value: "Bearer $LEAKTOKEN" }],
      }),
    ).execute();

    expect(mockedAxios).not.toHaveBeenCalled();
    expect(r.status).toBe("DOWN");
    expect(r.type).toBe("ERROR");
    expect(r.error_message).toContain("Refusing to send a secret");
  });

  it("refuses a secret in the query string, not only in a header", async () => {
    // Worse than a header in practice: a query string is recorded in every
    // proxy and server access log on the way.
    process.env.LEAKTOKEN = "s3cr3t";
    const r = await new ApiCall(monitorWith({ url: "http://internal/?token=$LEAKTOKEN", method: "GET" })).execute();
    expect(mockedAxios).not.toHaveBeenCalled();
    expect(r.error_message).toContain("Refusing to send a secret");
  });

  it("allows the same monitor over https", async () => {
    process.env.LEAKTOKEN = "s3cr3t";
    await new ApiCall(
      monitorWith({
        url: "https://api.example.com/",
        method: "GET",
        headers: [{ key: "Authorization", value: "Bearer $LEAKTOKEN" }],
      }),
    ).execute();
    expect(mockedAxios).toHaveBeenCalled();
  });

  it("allows plaintext when the monitor has opted out", async () => {
    process.env.LEAKTOKEN = "s3cr3t";
    await new ApiCall(
      monitorWith({
        url: "http://internal:8080/",
        method: "GET",
        allowPlaintextSecrets: true,
        headers: [{ key: "Authorization", value: "Bearer $LEAKTOKEN" }],
      }),
    ).execute();
    expect(mockedAxios).toHaveBeenCalled();
  });

  it("allows plaintext when the reference never resolved", async () => {
    // `$NOSUCHVAR` is sent as the literal string, which is not a credential.
    // Refusing on the mention alone would break monitors that have been sending
    // a harmless placeholder for months.
    delete process.env.NOSUCHVAR;
    await new ApiCall(
      monitorWith({
        url: "http://internal:8080/",
        method: "GET",
        headers: [{ key: "Authorization", value: "Bearer $NOSUCHVAR" }],
      }),
    ).execute();
    expect(mockedAxios).toHaveBeenCalled();
  });

  it("arms the redirect guard on the request it does make", async () => {
    // The downgrade case: an https config answering 302 to http. axios follows
    // it by default and carries the header with it, and nothing in the monitor's
    // configuration looks wrong.
    process.env.LEAKTOKEN = "s3cr3t";
    await new ApiCall(
      monitorWith({
        url: "https://api.example.com/",
        method: "GET",
        headers: [{ key: "Authorization", value: "Bearer $LEAKTOKEN" }],
      }),
    ).execute();

    const options = mockedAxios.mock.calls[0][1] as { beforeRedirect?: (o: { href: string }) => void };
    expect(typeof options.beforeRedirect).toBe("function");
    expect(() => options.beforeRedirect!({ href: "http://evil.example/downgraded" })).toThrow(/Refusing to send/);
    expect(() => options.beforeRedirect!({ href: "https://api.example.com/moved" })).not.toThrow();
  });
});
