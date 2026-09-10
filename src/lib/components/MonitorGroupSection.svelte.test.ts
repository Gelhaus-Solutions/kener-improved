import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import MonitorGroupSection from "./MonitorGroupSection.svelte";
import GC from "$lib/global-constants";
import { summariseStatuses } from "$lib/client/monitorGrouping";
import { createRawSnippet } from "svelte";
import type { StatusType } from "$lib/types/status";

// G2's acceptance criterion is specifically about a **collapsed** group: "a
// collapsed group's summary status equals the worst of its members". Server
// rendered HTML can never show that - with no bar data every summary is NO_DATA -
// so it is asserted here, with the summary derived the way the page derives it.

const body = () => createRawSnippet(() => ({ render: () => `<div>members</div>` }));

function renderSection(members: Array<StatusType | undefined>, open: boolean) {
  return render(MonitorGroupSection, {
    label: "Network",
    count: members.length,
    // Derived exactly as MonitorList derives it, so this asserts the real
    // pipeline rather than a hand-written expectation of it.
    summaryStatus: summariseStatuses(members),
    showSummary: true,
    open,
    ontoggle: () => {},
    children: body(),
  });
}

describe("MonitorGroupSection", () => {
  it("shows the worst member's status while collapsed", async () => {
    // Four healthy members and one broken one: the summary is DOWN, and the
    // proportion never softens it (ADR 0007).
    const screen = renderSection([GC.UP, GC.UP, GC.UP, GC.UP, GC.DOWN], false);

    await expect.element((await screen).getByText("DOWN")).toBeVisible();
    await expect.element((await screen).getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("does not render its members while collapsed", async () => {
    const screen = await renderSection([GC.UP, GC.DOWN], false);
    await expect.element(screen.getByText("members")).not.toBeInTheDocument();
  });

  it("renders its members when open, and the same summary", async () => {
    const screen = await renderSection([GC.UP, GC.DOWN], true);
    await expect.element(screen.getByText("members")).toBeVisible();
    await expect.element(screen.getByText("DOWN")).toBeVisible();
  });

  it("does not let maintenance mask a broken member", async () => {
    const screen = await renderSection([GC.MAINTENANCE, GC.DOWN], false);
    await expect.element(screen.getByText("DOWN")).toBeVisible();
  });

  it("reports NO_DATA rather than UP before any member has loaded", async () => {
    const screen = await renderSection([undefined, undefined], false);
    // Either form: the header renders `$t(status)`, and this suite deliberately
    // does not stub the i18n store (see vitest-setup-client.ts), so the key falls
    // through untranslated here while the server renders "No Data". The claim
    // being made is about the status, not about which locale is loaded.
    await expect.element(screen.getByText(/^(No Data|NO_DATA)$/)).toBeVisible();
    await expect.element(screen.getByText("UP")).not.toBeInTheDocument();
  });

  it("labels the uncategorised section Other", async () => {
    const screen = await render(MonitorGroupSection, {
      label: null,
      count: 1,
      summaryStatus: GC.UP,
      showSummary: true,
      open: false,
      ontoggle: () => {},
      children: body(),
    });
    await expect.element(screen.getByText("Other")).toBeVisible();
  });

  it("hides the summary when the page setting is off", async () => {
    const screen = await render(MonitorGroupSection, {
      label: "Network",
      count: 2,
      summaryStatus: GC.DOWN,
      showSummary: false,
      open: false,
      ontoggle: () => {},
      children: body(),
    });
    await expect.element(screen.getByText("DOWN")).not.toBeInTheDocument();
  });

  it("reports the toggle rather than owning the open state", async () => {
    // The page overrides open-ness while a filter is active, which is why this
    // is a callback and not a two-way binding.
    const ontoggle = vi.fn();
    const screen = await render(MonitorGroupSection, {
      label: "Network",
      count: 1,
      summaryStatus: GC.UP,
      showSummary: true,
      open: false,
      ontoggle,
      children: body(),
    });

    await screen.getByRole("button").click();
    expect(ontoggle).toHaveBeenCalledExactlyOnceWith(true);
    // Still closed: the parent decides, and the parent was a spy.
    await expect.element(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });
});
