import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
<<<<<<< HEAD
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
=======
import { HEARTBEAT_SECRET_RULE } from "$lib/anywhere";
import type { HeartbeatMonitorTypeData } from "$lib/server/types/monitor";
import MonitorHeartbeat from "./monitor-heartbeat.svelte";

describe("monitor-heartbeat form", () => {
  it("builds the heartbeat URL from the typed heartbeat secret", async () => {
    const data = $state({ secretString: "old-secret-value" } as HeartbeatMonitorTypeData);
    const screen = await render(MonitorHeartbeat, { data, tag: "hb-mon" });

    await screen.getByLabelText("Heartbeat secret").fill("my-alertmanager-hb-01");

    await expect
      .element(screen.getByLabelText("Heartbeat URL"))
      .toHaveValue(`${window.location.origin}/ext/heartbeat/hb-mon/my-alertmanager-hb-01`);
    await expect.element(screen.getByLabelText("Heartbeat secret")).toBeValid();
    expect(data.secretString).toBe("my-alertmanager-hb-01");
  });

  it("marks a secret that breaks the rule as invalid", async () => {
    const data = $state({ secretString: "my-alertmanager-hb-01" } as HeartbeatMonitorTypeData);
    const screen = await render(MonitorHeartbeat, { data, tag: "hb-mon" });

    await expect.element(screen.getByText(HEARTBEAT_SECRET_RULE)).toBeVisible();

    await screen.getByLabelText("Heartbeat secret").fill("a/b?c");
    await expect.element(screen.getByLabelText("Heartbeat secret")).toBeInvalid();

    await screen.getByLabelText("Heartbeat secret").fill("abcdefghijk");
    await expect.element(screen.getByLabelText("Heartbeat secret")).toBeInvalid();

    await screen.getByLabelText("Heartbeat secret").fill("abcdefghijkl");
    await expect.element(screen.getByLabelText("Heartbeat secret")).toBeValid();
  });

  it("accepts the stored secret while unchanged, even one the rule would reject", async () => {
    const data = $state({ secretString: "ab" } as HeartbeatMonitorTypeData);
    const screen = await render(MonitorHeartbeat, { data, tag: "hb-mon" });
    const input = screen.getByLabelText("Heartbeat secret");

    await expect.element(input).toBeValid();

    await input.fill("abc");
    await expect.element(input).toBeInvalid();

    await input.fill("ab");
    await expect.element(input).toBeValid();
  });

  it("generates a secret once on load and lets the user clear it", async () => {
    const data = $state({} as HeartbeatMonitorTypeData);
    const screen = await render(MonitorHeartbeat, { data, tag: "hb-mon" });

    const generated = data.secretString;
    expect(generated).toMatch(/^[A-Za-z0-9._~-]{12,}$/);
    await expect.element(screen.getByLabelText("Heartbeat secret")).toHaveValue(generated);

    await screen.getByLabelText("Heartbeat secret").clear();

    await expect.element(screen.getByLabelText("Heartbeat secret")).toHaveValue("");
    await expect.element(screen.getByLabelText("Heartbeat secret")).toBeInvalid();
    expect(data.secretString).toBe("");
>>>>>>> 121610d3a26d408436a53bf2444e9b798dbee848
  });
});
