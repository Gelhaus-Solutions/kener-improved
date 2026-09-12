import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { timezone } from "$lib/stores/timezone";
import type { MaintenanceEventsMonitorList } from "$lib/server/types/db";

vi.mock("$app/state", () => ({
  page: { route: { id: "/(kener)/maintenances" }, data: { dateAndTimeFormat: { datePlusTime: "PPpp" } } },
}));

const MaintenanceItem = (await import("./MaintenanceItem.svelte")).default;

// 2026-01-15T14:00:00Z to 2026-01-15T16:30:00Z. Winter, so Berlin is +1.
const maintenance = {
  id: 1,
  maintenance_id: 1,
  title: "Database upgrade",
  description: "",
  start_date_time: 1768485600,
  end_date_time: 1768494600,
  status: "SCHEDULED",
  is_global: "NO",
  monitors: [],
} as unknown as MaintenanceEventsMonitorList;

/**
 * D5. The page renders in the viewer's zone and a notification mail renders in
 * UTC. Unless the page says which zone it is showing, the two read as two
 * different times for one instant, which is the bug this closes.
 */
describe("MaintenanceItem timezone labelling", () => {
  timezone.init();

  it("names the zone beside the start and end times", async () => {
    timezone.setTimezone("Europe/Berlin");
    const screen = await render(MaintenanceItem, { maintenance });

    // 14:00Z is 15:00 in Berlin in January, and the label has to say so.
    await expect.element(screen.getByText(/3:00:00 PM/)).toBeInTheDocument();
    // BOTH ends, not just one: asserting "at least one" passes with the start
    // label deleted, which a mutation proved.
    expect(screen.getByText("GMT+1").elements()).toHaveLength(2);
  });

  it("changes the label with the viewer's chosen zone", async () => {
    timezone.setTimezone("UTC");
    const screen = await render(MaintenanceItem, { maintenance });

    await expect.element(screen.getByText(/2:00:00 PM/)).toBeInTheDocument();
    expect(screen.getByText("UTC").elements()).toHaveLength(2);
  });
});
