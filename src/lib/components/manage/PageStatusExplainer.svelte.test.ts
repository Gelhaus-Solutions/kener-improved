import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import PageStatusExplainer from "./PageStatusExplainer.svelte";
import type { ComponentExplanation, PageExplanation } from "$lib/server/incidents/explain.js";

/**
 * The panel is opened during an outage by somebody asking one question, so the
 * two things worth holding down are that the answer is on screen and that the
 * components answering it are at the top.
 */
const component = (over: Partial<ComponentExplanation> = {}): ComponentExplanation => ({
  monitor_tag: "api",
  name: "The API",
  impact: "OPERATIONAL",
  summary: "All Systems Operational",
  source: "monitoring",
  reason: "Its own check last reported UP, and nothing is declared against it.",
  own_status: "UP",
  own_check: "UP",
  incidents: [],
  maintenances: [],
  inherited_from: [],
  pin: null,
  counted: true,
  ...over,
});

const explanation = (over: Partial<PageExplanation> = {}): PageExplanation & { page_name: string } => ({
  page_name: "Service status",
  headline: "Partial System Outage",
  counts: { up: 1, down: 1, degraded: 0, maintenance: 0 },
  headline_reason: "1 of 2 components is down, which is 50%. Below 75% the page says partial rather than major.",
  components: [component()],
  ...over,
});

/** The rendered text, with the whitespace the template's line breaks add collapsed. */
const copy = (container: HTMLElement) => (container.textContent ?? "").replace(/\s+/g, " ");

describe("PageStatusExplainer", () => {
  it("puts the headline's arithmetic on screen", async () => {
    const screen = await render(PageStatusExplainer, { explanation: explanation() });

    await expect.element(screen.getByText("Partial System Outage")).toBeVisible();
    expect(copy(screen.container)).toContain("1 of 2 components is down, which is 50%");
  });

  it("names the rule that decided each component", async () => {
    const screen = await render(PageStatusExplainer, {
      explanation: explanation({
        components: [
          component({
            monitor_tag: "sso",
            name: "SSO",
            impact: "MAJOR_OUTAGE",
            summary: "Major System Outage",
            source: "rollup",
            reason: "Inherited from Postgres. Its own check last reported UP.",
            own_status: "DOWN",
            own_check: "UP",
            inherited_from: ["Postgres"],
          }),
        ],
      }),
    });

    const text = copy(screen.container);
    expect(text).toContain("from dependency");
    expect(text).toContain("Inherited from Postgres");
  });

  /**
   * The screenshot that started this: a headline disagreeing with the monitor's
   * own check, with nothing on the page saying the two were different things.
   */
  it("spells out a published status that differs from the check's own observation", async () => {
    const screen = await render(PageStatusExplainer, {
      explanation: explanation({
        components: [component({ own_status: "DOWN", own_check: "UP", source: "rollup" })],
      }),
    });

    expect(copy(screen.container)).toContain("Published as DOWN, but its own check observed UP");
  });

  it("says nothing about the two when they agree", async () => {
    const screen = await render(PageStatusExplainer, { explanation: explanation() });
    expect(copy(screen.container)).not.toContain("but its own check observed");
  });

  it("orders the components that answer the question first", async () => {
    const screen = await render(PageStatusExplainer, {
      explanation: explanation({
        components: [
          component({ monitor_tag: "a", name: "Healthy" }),
          component({ monitor_tag: "b", name: "Broken", impact: "MAJOR_OUTAGE", summary: "Major System Outage" }),
          component({ monitor_tag: "c", name: "Slow", impact: "DEGRADED_PERFORMANCE", summary: "Degraded" }),
        ],
      }),
    });

    const text = copy(screen.container);
    expect(text.indexOf("Broken")).toBeLessThan(text.indexOf("Slow"));
    expect(text.indexOf("Slow")).toBeLessThan(text.indexOf("Healthy"));
  });

  it("keeps an uncounted component with the problems, not with the healthy ones", async () => {
    // It is excluded from the headline's arithmetic, which is exactly the kind
    // of thing this panel exists to stop being invisible.
    const screen = await render(PageStatusExplainer, {
      explanation: explanation({
        components: [
          component({ monitor_tag: "a", name: "Healthy" }),
          component({ monitor_tag: "z", name: "Never reported", source: "silent", counted: false }),
        ],
      }),
    });

    const text = copy(screen.container);
    expect(text).toContain("not counted in the headline");
    expect(text.indexOf("Never reported")).toBeLessThan(text.indexOf("Healthy"));
  });

  it("reports a pin and when it lapses", async () => {
    const screen = await render(PageStatusExplainer, {
      explanation: explanation({
        components: [component({ pin: { impact: "UNDER_MAINTENANCE", expires_at: 1789000000 } })],
      }),
    });

    expect(copy(screen.container)).toContain("Pinned at UNDER_MAINTENANCE, until 2026-09-10 00:26 UTC");
  });

  it("shows an error instead of an empty panel", async () => {
    const screen = await render(PageStatusExplainer, { explanation: null, error: "That page does not exist" });
    await expect.element(screen.getByText("That page does not exist")).toBeVisible();
  });
});
