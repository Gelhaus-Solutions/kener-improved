import { describe, it, expect } from "vitest";
import { parseHeartbeatReport, MAX_DURATION_MS } from "./heartbeatReport.js";

const q = (s: string) => new URLSearchParams(s);

describe("parseHeartbeatReport", () => {
  it("reports nothing for a bare ping", () => {
    expect(parseHeartbeatReport({}, q(""))).toEqual({});
  });

  it("reads an exit code from the query string", () => {
    expect(parseHeartbeatReport({}, q("exit_code=2"))).toEqual({ exitCode: 2 });
    expect(parseHeartbeatReport({}, q("exitCode=2"))).toEqual({ exitCode: 2 });
  });

  it("keeps exit code zero, which is not the same as absent", () => {
    // Absent means the job did not say; zero means it said it succeeded.
    expect(parseHeartbeatReport({}, q("exit_code=0"))).toEqual({ exitCode: 0 });
  });

  it("accepts a status word so a shell script need not invent a number", () => {
    expect(parseHeartbeatReport({}, q("status=fail")).exitCode).toBe(1);
    expect(parseHeartbeatReport({}, q("status=FAILURE")).exitCode).toBe(1);
    expect(parseHeartbeatReport({}, q("status=ok")).exitCode).toBe(0);
  });

  it("prefers an explicit exit code over a status word", () => {
    expect(parseHeartbeatReport({}, q("status=ok&exit_code=3")).exitCode).toBe(3);
  });

  it("ignores a status word it does not recognise", () => {
    expect(parseHeartbeatReport({}, q("status=weird")).exitCode).toBeUndefined();
  });

  it("reads a duration in milliseconds", () => {
    expect(parseHeartbeatReport({}, q("duration_ms=4321")).durationMs).toBe(4321);
  });

  it("accepts seconds, which is what time and most CI variables report", () => {
    expect(parseHeartbeatReport({}, q("duration=12")).durationMs).toBe(12_000);
    expect(parseHeartbeatReport({}, q("duration_s=12")).durationMs).toBe(12_000);
  });

  it("prefers an explicit millisecond duration over a seconds one", () => {
    expect(parseHeartbeatReport({}, q("duration=12&duration_ms=500")).durationMs).toBe(500);
  });

  it("drops a duration that is negative or absurd", () => {
    expect(parseHeartbeatReport({}, q("duration_ms=-1")).durationMs).toBeUndefined();
    expect(parseHeartbeatReport({}, q(`duration_ms=${MAX_DURATION_MS + 1}`)).durationMs).toBeUndefined();
    expect(parseHeartbeatReport({}, q(`duration_ms=${MAX_DURATION_MS}`)).durationMs).toBe(MAX_DURATION_MS);
  });

  it("drops values that do not parse rather than rejecting the heartbeat", () => {
    // The ping still counts. Losing the metadata beats losing the heartbeat.
    expect(parseHeartbeatReport({}, q("exit_code=banana&duration_ms=soon"))).toEqual({});
  });

  it("truncates a fractional duration", () => {
    expect(parseHeartbeatReport({}, q("duration_ms=12.9")).durationMs).toBe(12);
  });

  it("reads a JSON body", () => {
    expect(parseHeartbeatReport({ exit_code: 1, duration_ms: 250 }, q(""))).toEqual({ exitCode: 1, durationMs: 250 });
  });

  it("lets the body win over the query string", () => {
    expect(parseHeartbeatReport({ exit_code: 7 }, q("exit_code=1")).exitCode).toBe(7);
  });

  it("accepts camelCase in a JSON body", () => {
    expect(parseHeartbeatReport({ exitCode: 4, durationMs: 9 }, q(""))).toEqual({ exitCode: 4, durationMs: 9 });
  });

  it("ignores a boolean, which is a caller confusing the field for a flag", () => {
    expect(parseHeartbeatReport({ exit_code: true }, q(""))).toEqual({});
  });
});
