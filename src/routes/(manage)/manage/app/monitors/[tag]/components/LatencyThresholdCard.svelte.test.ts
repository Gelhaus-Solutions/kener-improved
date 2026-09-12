import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import LatencyThresholdCard from "./LatencyThresholdCard.svelte";
import type { MonitorRecord } from "$lib/server/types/db.js";

vi.mock("svelte-sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/**
 * The percentile trap, on screen.
 *
 * `percentileOf` ranks at ceil(q*n)-1, so a p95 over five samples is just the
 * slowest of the five. The rule is not changing - the form has to say so, with
 * the window that would actually work at this monitor's own schedule.
 */
const monitorWith = (cron: string, latency: Record<string, unknown>): MonitorRecord =>
  ({
    id: 1,
    tag: "test",
    name: "Test",
    cron,
    monitor_settings_json: JSON.stringify({ latency_threshold: latency }),
  }) as unknown as MonitorRecord;

const custom = (over: Record<string, unknown> = {}) => ({
  mode: "CUSTOM",
  enabled: true,
  metric: "p95",
  window_minutes: 5,
  min_samples: 3,
  degraded_ms: 1000,
  down_ms: null,
  ...over,
});

/** The rendered copy, with the whitespace the template's line breaks add collapsed. */
const copy = (container: HTMLElement) => (container.textContent ?? "").replace(/\s+/g, " ");

describe("LatencyThresholdCard sample warning", () => {
  it("warns that a five minute window cannot produce a p95 on a one minute cron", async () => {
    const screen = await render(LatencyThresholdCard, {
      monitor: monitorWith("* * * * *", custom()),
      typeData: {},
    });

    await expect.element(screen.getByText("This window is too short for p95")).toBeVisible();
    const text = copy(screen.container);
    expect(text).toContain("5 minutes holds about 5 checks");
    expect(text).toContain("p95 needs 20 before it is anything other than the slowest one");
    expect(text).toContain("Use a window of 20 minutes");
  });

  it("is quiet once the window holds enough checks", async () => {
    const screen = await render(LatencyThresholdCard, {
      monitor: monitorWith("* * * * *", custom({ window_minutes: 20 })),
      typeData: {},
    });

    expect(screen.container.textContent).not.toContain("This window is too short");
  });

  it("suggests a window scaled to this monitor's own schedule, not an assumed minute", async () => {
    // A five minute cron puts twenty samples a hundred minutes apart.
    const screen = await render(LatencyThresholdCard, {
      monitor: monitorWith("*/5 * * * *", custom({ window_minutes: 20 })),
      typeData: {},
    });

    await expect.element(screen.getByText("This window is too short for p95")).toBeVisible();
    expect(copy(screen.container)).toContain("Use a window of 100 minutes");
  });

  it("never warns about avg, which is not a rank", async () => {
    const screen = await render(LatencyThresholdCard, {
      monitor: monitorWith("* * * * *", custom({ metric: "avg" })),
      typeData: {},
    });

    expect(screen.container.textContent).not.toContain("This window is too short");
  });

  it("says nothing when the monitor is on the site default, where these numbers are not shown", async () => {
    const screen = await render(LatencyThresholdCard, {
      monitor: monitorWith("* * * * *", { mode: "INHERIT" }),
      typeData: {},
    });

    expect(screen.container.textContent).not.toContain("This window is too short");
  });
});
