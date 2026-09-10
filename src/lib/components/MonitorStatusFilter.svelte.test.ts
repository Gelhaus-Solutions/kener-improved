import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import MonitorStatusFilter from "./MonitorStatusFilter.svelte";
import GC from "$lib/global-constants";
import { ALL_FILTER } from "$lib/client/monitorGrouping";
import type { StatusType } from "$lib/types/status";

// G1's acceptance criterion is a claim about the *browser*: "filtering to DOWN on
// a 100-monitor page issues no network request". That is not something a server
// side driver can observe, so it is asserted here, in a real Chromium, by
// spying on `fetch` across the interaction.
//
// The other half of G1 - which tags survive a filter, how counts are derived -
// is pure logic and is covered by `client/monitorGrouping.test.ts`. This file
// covers only what needs a rendered component.

/** A hundred monitors, mostly UP, with a handful broken. */
function makeFixture(total = 100) {
  const tags = Array.from({ length: total }, (_, i) => `monitor-${i}`);
  const statusByTag: Record<string, StatusType | undefined> = {};
  tags.forEach((tag, i) => {
    if (i % 25 === 0) statusByTag[tag] = GC.DOWN;
    else if (i % 10 === 0) statusByTag[tag] = GC.DEGRADED;
    else statusByTag[tag] = GC.UP;
  });
  return { tags, statusByTag };
}

describe("MonitorStatusFilter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("issues no network request when a filter is selected on a 100-monitor page", async () => {
    const { tags, statusByTag } = makeFixture(100);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const screen = await render(MonitorStatusFilter, { tags, statusByTag, value: ALL_FILTER });

    await screen.getByRole("button", { name: /DOWN/ }).click();
    await screen.getByRole("button", { name: /DEGRADED/ }).click();
    await screen.getByRole("button", { name: /All/ }).click();

    // The whole point of G1: every status the chips read was already fetched for
    // the bars, so selecting one costs nothing.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders a chip per present status, with its count", async () => {
    const { tags, statusByTag } = makeFixture(100);
    const screen = await render(MonitorStatusFilter, { tags, statusByTag, value: ALL_FILTER });

    // DOWN: i % 25 === 0            -> 0, 25, 50, 75                  = 4
    // DEGRADED: i % 10 === 0, minus the ones already DOWN (0 and 50)
    //                               -> 10, 20, 30, 40, 60, 70, 80, 90  = 8
    // UP: everything else                                              = 88
    await expect.element(screen.getByRole("button", { name: /All\s*100/ })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /DOWN\s*4/ })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /DEGRADED\s*8/ })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /UP\s*88/ })).toBeVisible();
  });

  it("renders no chip for a status nothing is at", async () => {
    const tags = ["a", "b"];
    const statusByTag: Record<string, StatusType | undefined> = { a: GC.UP, b: GC.DOWN };
    const screen = await render(MonitorStatusFilter, { tags, statusByTag, value: ALL_FILTER });

    // Nothing is under maintenance, so there is no maintenance chip to click.
    await expect.element(screen.getByRole("button", { name: /MAINTENANCE/ })).not.toBeInTheDocument();
  });

  it("renders nothing at all when every monitor is at the same status", async () => {
    // A healthy page must not grow a control row that offers no choice.
    const tags = ["a", "b", "c"];
    const statusByTag: Record<string, StatusType | undefined> = { a: GC.UP, b: GC.UP, c: GC.UP };
    const screen = await render(MonitorStatusFilter, { tags, statusByTag, value: ALL_FILTER });

    await expect.element(screen.getByRole("group")).not.toBeInTheDocument();
  });

  it("marks the selected chip as pressed", async () => {
    const { tags, statusByTag } = makeFixture(100);
    const screen = await render(MonitorStatusFilter, { tags, statusByTag, value: ALL_FILTER });

    const all = screen.getByRole("button", { name: /All/ });
    const down = screen.getByRole("button", { name: /DOWN/ });

    await expect.element(all).toHaveAttribute("aria-pressed", "true");
    await down.click();
    await expect.element(down).toHaveAttribute("aria-pressed", "true");
    await expect.element(all).toHaveAttribute("aria-pressed", "false");
  });
});
