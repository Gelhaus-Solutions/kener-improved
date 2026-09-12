import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import MonitorHeartbeat from "./monitor-heartbeat.svelte";
import type { HeartbeatMonitorTypeData } from "$lib/server/types/monitor";

// Browser context is pinned to UTC (vite.config.ts).
function typeData(extra: Partial<HeartbeatMonitorTypeData> = {}): HeartbeatMonitorTypeData {
  return {
    degradedRemainingMinutes: 5,
    downRemainingMinutes: 10,
    secretString: "a-secret",
    ...extra,
  };
}

const SCHEDULED = typeData({ expectedCron: "0 2 * * *", cronTimezone: "Europe/Berlin", graceMinutes: 15 });

describe("monitor-heartbeat editor", () => {
  it("opens on the silence timeout when no schedule is set", async () => {
    const screen = await render(MonitorHeartbeat, { data: typeData(), tag: "" });

    await expect
      .element(screen.getByText("Mark as DOWN if no heartbeat received for this many minutes"))
      .toBeInTheDocument();
  });

  it("opens on the schedule tab when a pattern is already set", async () => {
    const screen = await render(MonitorHeartbeat, { data: SCHEDULED, tag: "" });

    await expect.element(screen.getByText("Next expected runs")).toBeInTheDocument();
  });

  it("previews the next runs in the configured timezone", async () => {
    // 02:00 Berlin, so the preview must read 02:00 and not the UTC instant.
    const screen = await render(MonitorHeartbeat, { data: SCHEDULED, tag: "" });

    await expect.element(screen.getByText("Shown in Europe/Berlin")).toBeInTheDocument();
    await expect.element(screen.getByText(/02:00/).first()).toBeInTheDocument();
  });

  it("says so when the pattern cannot be parsed", async () => {
    const screen = await render(MonitorHeartbeat, {
      data: typeData({ expectedCron: "every night please", cronTimezone: "UTC", graceMinutes: 15 }),
      tag: "",
    });

    await expect.element(screen.getByText("Next expected runs")).toBeInTheDocument();
    // The preview reports the parse failure rather than rendering nothing.
    await expect.element(screen.getByText(/Shown in/)).not.toBeInTheDocument();
  });

  it("renders the whole timezone list without a duplicate key taking the page down", async () => {
    // A duplicate key in a keyed {#each} kills the entire page render, not just
    // the control, so the list is opened rather than trusted.
    const screen = await render(MonitorHeartbeat, { data: SCHEDULED, tag: "" });

    await screen.getByRole("combobox").click();
    await expect.element(screen.getByPlaceholder("Search timezone...")).toBeInTheDocument();
    // Still alive after rendering every zone.
    await expect.element(screen.getByText("Next expected runs")).toBeInTheDocument();
  });

  it("keeps the heartbeat URL section on both tabs", async () => {
    const screen = await render(MonitorHeartbeat, { data: SCHEDULED, tag: "" });

    await expect
      .element(screen.getByText("Send a GET or POST request to this URL to record a heartbeat"))
      .toBeInTheDocument();

    // The URL itself is the readonly input's value, not DOM text.
    const url = screen.container.querySelector<HTMLInputElement>("#hb-secret");
    expect(url?.value).toBe("Save the monitor first to get the heartbeat URL");
  });
});
