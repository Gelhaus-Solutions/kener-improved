import { describe, it, expect } from "vitest";
import { CSV_COLUMNS, __testing } from "./csvUptimeReport.js";
import type { MonitorRollup } from "../types/db.js";

const { csvEscape, rowToLine, isoUtc, formatPercent } = __testing;

describe("csvEscape", () => {
  it("leaves ordinary text alone", () => {
    expect(csvEscape("api-gateway")).toBe("api-gateway");
  });

  it("quotes a value containing a comma", () => {
    // The failure this prevents is silent: an unquoted comma shifts every later
    // column on the line by one, and the file still opens cleanly.
    expect(csvEscape("Checkout, EU")).toBe('"Checkout, EU"');
  });

  it("doubles embedded quotes", () => {
    expect(csvEscape('The "main" API')).toBe('"The ""main"" API"');
  });

  it("quotes a value containing a newline", () => {
    expect(csvEscape("line one\nline two")).toBe('"line one\nline two"');
  });

  it("renders null and undefined as an empty field, not as the word null", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
});

describe("isoUtc", () => {
  it("formats seconds as UTC with no fractional part", () => {
    expect(isoUtc(0)).toBe("1970-01-01T00:00:00Z");
    expect(isoUtc(1767225600)).toBe("2026-01-01T00:00:00Z");
  });
});

describe("formatPercent", () => {
  it("keeps four decimals so three nines is distinguishable from four", () => {
    expect(formatPercent(99.99)).toBe("99.9900");
    expect(formatPercent(99.999)).toBe("99.9990");
  });

  it("emits an empty field for an unmeasurable bucket", () => {
    expect(formatPercent(null)).toBe("");
  });
});

function row(overrides: Partial<MonitorRollup>): MonitorRollup {
  return {
    monitor_tag: "api",
    bucket_start: 1767225600,
    count_total: 60,
    count_up: 59,
    count_down: 1,
    count_degraded: 0,
    count_maintenance: 0,
    count_no_data: 0,
    count_in_maint_window: 0,
    count_up_excl_maint: 59,
    count_down_excl_maint: 1,
    count_degraded_excl_maint: 0,
    latency_count: 60,
    latency_sum: 6000,
    latency_min: 80,
    latency_max: 220,
    latency_p50: 95,
    latency_p90: 180,
    latency_p95: 200,
    latency_p99: 215,
    ...overrides,
  } as unknown as MonitorRollup;
}

describe("rowToLine", () => {
  const terms = { excludeMaintenance: true, degradedCountsAsBad: false };

  it("emits exactly one cell per declared column", () => {
    // Guards the pairing that a header and a body written in two places can
    // silently break: a column added to one and not the other shifts the file.
    const line = rowToLine(row({}), "API", terms);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().split(",")).toHaveLength(CSV_COLUMNS.length);
  });

  it("computes uptime through the same classify the SLOs use", () => {
    const line = rowToLine(row({}), "API", terms).trimEnd().split(",");
    const uptimeIndex = CSV_COLUMNS.indexOf("uptime_percent");
    expect(line[uptimeIndex]).toBe(((59 / 60) * 100).toFixed(4));
  });

  it("carries the stored per-bucket percentiles verbatim", () => {
    // Correct precisely because one row is one bucket: the stored p95 is
    // authoritative at its own grain and needs no histogram merge.
    const cells = rowToLine(row({}), "API", terms).trimEnd().split(",");
    expect(cells[CSV_COLUMNS.indexOf("latency_p95_ms")]).toBe("200.00");
    expect(cells[CSV_COLUMNS.indexOf("latency_p50_ms")]).toBe("95.00");
  });

  it("leaves latency cells empty when the bucket recorded none", () => {
    const cells = rowToLine(
      row({ latency_count: 0, latency_sum: 0, latency_min: null, latency_max: null, latency_p95: null }),
      "API",
      terms,
    )
      .trimEnd()
      .split(",");
    expect(cells[CSV_COLUMNS.indexOf("latency_avg_ms")]).toBe("");
    expect(cells[CSV_COLUMNS.indexOf("latency_p95_ms")]).toBe("");
  });

  it("quotes a monitor name containing a comma so the row does not shift", () => {
    const line = rowToLine(row({}), "Checkout, EU", terms);
    expect(line).toContain('"Checkout, EU"');
    expect(line.trimEnd().split(",")).toHaveLength(CSV_COLUMNS.length + 1);
    // Split on the quoted form instead, to prove the field is one cell.
    const cells = line
      .trimEnd()
      .match(/("([^"]|"")*"|[^,]*)/g)
      ?.filter((_, i) => i % 2 === 0);
    expect(cells?.[1]).toBe('"Checkout, EU"');
  });

  it("honours maintenance exclusion, matching the model summary", () => {
    const maintenanceRow = row({
      count_up: 30,
      count_down: 30,
      count_in_maint_window: 30,
      count_up_excl_maint: 30,
      count_down_excl_maint: 0,
    });
    const excluded = rowToLine(maintenanceRow, "API", { excludeMaintenance: true, degradedCountsAsBad: false })
      .trimEnd()
      .split(",");
    const included = rowToLine(maintenanceRow, "API", { excludeMaintenance: false, degradedCountsAsBad: false })
      .trimEnd()
      .split(",");
    const index = CSV_COLUMNS.indexOf("uptime_percent");
    expect(excluded[index]).toBe("100.0000");
    expect(included[index]).toBe("50.0000");
  });
});
