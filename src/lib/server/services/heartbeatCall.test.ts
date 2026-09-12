import { describe, it, expect, vi, beforeEach } from "vitest";
import GC from "../../global-constants.js";
import type { HeartbeatMonitor, HeartbeatMonitorTypeData } from "../types/monitor.js";

const nowMock = vi.hoisted(() => ({ value: 0 }));
const cacheMock = vi.hoisted(() => ({ value: null as unknown }));
const dbMock = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("../tool.js", () => ({
  GetNowTimestampUTCInMs: () => nowMock.value,
}));
vi.mock("../cache/setGet.js", () => ({
  GetLastHeartbeat: async () => cacheMock.value,
}));
vi.mock("../controllers/monitorsController.js", () => ({
  GetLastHeartbeat: async () => dbMock.value,
}));

const { default: HeartbeatCall } = await import("./heartbeatCall.js");

const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const ms = (iso: string) => new Date(iso).getTime();

function monitor(typeData: Partial<HeartbeatMonitorTypeData>): HeartbeatMonitor {
  return {
    tag: "nightly-backup",
    type_data: {
      degradedRemainingMinutes: 5,
      downRemainingMinutes: 10,
      secretString: "s",
      ...typeData,
    },
  } as HeartbeatMonitor;
}

const DAILY_0200: Partial<HeartbeatMonitorTypeData> = {
  expectedCron: "0 2 * * *",
  cronTimezone: "UTC",
  graceMinutes: 15,
};

beforeEach(() => {
  cacheMock.value = null;
  dbMock.value = undefined;
});

describe("HeartbeatCall without a schedule", () => {
  it("keeps the original timeout behaviour", async () => {
    nowMock.value = ms("2026-09-12T10:00:00Z");
    cacheMock.value = { timestamp: sec("2026-09-12T09:58:00Z") };
    expect((await new HeartbeatCall(monitor({})).execute()).status).toBe(GC.UP);

    cacheMock.value = { timestamp: sec("2026-09-12T09:52:00Z") };
    expect((await new HeartbeatCall(monitor({})).execute()).status).toBe(GC.DEGRADED);

    cacheMock.value = { timestamp: sec("2026-09-12T09:45:00Z") };
    expect((await new HeartbeatCall(monitor({})).execute()).status).toBe(GC.DOWN);
  });

  it("reports NO_DATA when nothing has ever checked in", async () => {
    nowMock.value = ms("2026-09-12T10:00:00Z");
    expect((await new HeartbeatCall(monitor({})).execute()).status).toBe(GC.NO_DATA);
  });
});

describe("HeartbeatCall with a schedule", () => {
  it("is UP once the nightly run has checked in, however long ago", async () => {
    // The case a timeout gets wrong: 08:00 after a 02:00 run is healthy.
    nowMock.value = ms("2026-09-12T10:00:00Z");
    cacheMock.value = { timestamp: sec("2026-09-12T02:00:30Z") };

    expect((await new HeartbeatCall(monitor(DAILY_0200)).execute()).status).toBe(GC.UP);
  });

  it("is DEGRADED at 02:16 when the run did not arrive", async () => {
    // And promptly: a timeout could not flag this until hours later.
    nowMock.value = ms("2026-09-12T02:16:00Z");
    cacheMock.value = { timestamp: sec("2026-09-11T02:00:30Z") };

    const got = await new HeartbeatCall(monitor(DAILY_0200)).execute();
    expect(got.status).toBe(GC.DEGRADED);
    expect(got.error_message).toContain("grace exceeded");
  });

  it("is still UP inside the grace period", async () => {
    nowMock.value = ms("2026-09-12T02:10:00Z");
    cacheMock.value = { timestamp: sec("2026-09-11T02:00:30Z") };

    expect((await new HeartbeatCall(monitor(DAILY_0200)).execute()).status).toBe(GC.UP);
  });

  it("escalates to DOWN once a second window is missed", async () => {
    nowMock.value = ms("2026-09-12T02:16:00Z");
    cacheMock.value = { timestamp: sec("2026-09-10T02:00:30Z") };

    const got = await new HeartbeatCall(monitor(DAILY_0200)).execute();
    expect(got.status).toBe(GC.DOWN);
    expect(got.error_message).toContain("2 expected runs");
  });

  it("names the expected time in the schedule's own timezone", async () => {
    // 02:00 Berlin is 00:00Z. The operator wrote 02:00 and must read 02:00.
    nowMock.value = ms("2026-09-12T01:00:00Z");
    cacheMock.value = { timestamp: sec("2026-09-11T00:00:30Z") };

    const got = await new HeartbeatCall(monitor({ ...DAILY_0200, cronTimezone: "Europe/Berlin" })).execute();

    expect(got.status).toBe(GC.DEGRADED);
    expect(got.error_message).toContain("02:00");
    expect(got.error_message).toContain("Europe/Berlin");
  });

  it("falls back to the timeout when the pattern does not parse", async () => {
    // A typo must not take the monitor down.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    nowMock.value = ms("2026-09-12T10:00:00Z");
    cacheMock.value = { timestamp: sec("2026-09-12T09:58:00Z") };

    const got = await new HeartbeatCall(monitor({ ...DAILY_0200, expectedCron: "every night please" })).execute();

    expect(got.status).toBe(GC.UP);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("ignores a blank pattern and uses the timeout", async () => {
    nowMock.value = ms("2026-09-12T10:00:00Z");
    cacheMock.value = { timestamp: sec("2026-09-12T09:45:00Z") };

    expect((await new HeartbeatCall(monitor({ expectedCron: "   " })).execute()).status).toBe(GC.DOWN);
  });
});

describe("HeartbeatCall with a reported outcome", () => {
  it("is DOWN when the run reported a non-zero exit code", async () => {
    nowMock.value = ms("2026-09-12T02:01:00Z");
    cacheMock.value = { timestamp: sec("2026-09-12T02:00:30Z"), exitCode: 2 };

    const got = await new HeartbeatCall(monitor(DAILY_0200)).execute();
    expect(got.status).toBe(GC.DOWN);
    expect(got.error_message).toContain("exit code 2");
  });

  it("lets an explicit failure outrank a schedule that is satisfied", async () => {
    // The job checked in punctually and said it failed. Silence-based rules
    // cannot see this and would call it healthy.
    nowMock.value = ms("2026-09-12T10:00:00Z");
    cacheMock.value = { timestamp: sec("2026-09-12T02:00:30Z"), exitCode: 1 };

    expect((await new HeartbeatCall(monitor(DAILY_0200)).execute()).status).toBe(GC.DOWN);
  });

  it("treats exit code zero as success", async () => {
    nowMock.value = ms("2026-09-12T10:00:00Z");
    cacheMock.value = { timestamp: sec("2026-09-12T02:00:30Z"), exitCode: 0 };

    expect((await new HeartbeatCall(monitor(DAILY_0200)).execute()).status).toBe(GC.UP);
  });

  it("charts the reported run duration instead of time since the ping", async () => {
    nowMock.value = ms("2026-09-12T10:00:00Z");
    cacheMock.value = { timestamp: sec("2026-09-12T02:00:30Z"), durationMs: 4321 };

    expect((await new HeartbeatCall(monitor(DAILY_0200)).execute()).latency).toBe(4321);
  });

  it("falls back to time since the ping when no duration was reported", async () => {
    nowMock.value = ms("2026-09-12T10:00:00Z");
    cacheMock.value = { timestamp: sec("2026-09-12T09:59:00Z") };

    expect((await new HeartbeatCall(monitor({})).execute()).latency).toBe(60_000);
  });

  it("recovers a failed run from the signal row after a cache flush", async () => {
    nowMock.value = ms("2026-09-12T10:00:00Z");
    cacheMock.value = null;
    dbMock.value = { timestamp: sec("2026-09-12T02:00:30Z"), status: GC.DOWN, latency: 990 };

    const got = await new HeartbeatCall(monitor(DAILY_0200)).execute();
    expect(got.status).toBe(GC.DOWN);
    expect(got.latency).toBe(990);
  });

  it("recovers a healthy run from the signal row after a cache flush", async () => {
    nowMock.value = ms("2026-09-12T10:00:00Z");
    cacheMock.value = null;
    dbMock.value = { timestamp: sec("2026-09-12T02:00:30Z"), status: GC.UP, latency: 0 };

    expect((await new HeartbeatCall(monitor(DAILY_0200)).execute()).status).toBe(GC.UP);
  });
});
