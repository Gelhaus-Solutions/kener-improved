import { describe, it, expect } from "vitest";
import { explainComponent, explainHeadline, type ExplainInputs } from "./explain.js";
import { PAGE_STATUS_MESSAGES } from "../../global-constants.js";
import type { ComponentStatus } from "./pageStatus.js";
import type { ComponentImpact } from "./impact.js";
import type { DependencyEdge } from "./rollup.js";

/**
 * The panel's whole value is that it is right about a page somebody is staring
 * at during an outage. A plausible sentence attached to the wrong evidence is
 * worse than no panel, so these assert the sentence AND what it is drawn from.
 */
describe("explainHeadline", () => {
  const counts = (over: Partial<{ up: number; down: number; degraded: number; maintenance: number }> = {}) => ({
    up: 0,
    down: 0,
    degraded: 0,
    maintenance: 0,
    ...over,
  });

  it("says nothing has ever reported when nothing has", () => {
    expect(explainHeadline(PAGE_STATUS_MESSAGES.NO_DATA, counts())).toBe(
      "No component has ever reported, so the page has no status to show.",
    );
  });

  it("counts the operational components when everything is fine", () => {
    expect(explainHeadline(PAGE_STATUS_MESSAGES.ALL_OPERATIONAL, counts({ up: 12 }))).toBe(
      "All 12 counted components are operational.",
    );
  });

  /**
   * The question that cost four rounds of psql: one component down out of twelve
   * reads as "Partial System Outage", and nowhere did the page say why.
   */
  it("prints the arithmetic behind partial rather than major", () => {
    const reason = explainHeadline(PAGE_STATUS_MESSAGES.PARTIAL_OUTAGE, counts({ up: 11, down: 1 }));
    expect(reason).toContain("1 of 12 components is down, which is 8%");
    expect(reason).toContain("Below 75%");
  });

  it("explains the other side of the same threshold", () => {
    const reason = explainHeadline(PAGE_STATUS_MESSAGES.MAJOR_OUTAGE, counts({ up: 1, down: 3 }));
    expect(reason).toContain("3 of 4 components are down, which is 75%");
    expect(reason).toContain("At or above 75%");
  });

  it("says the threshold is about wording, not about whether anything is down", () => {
    // ADR 0007: the 75% rule can never turn a down bucket into an up one, and
    // an operator reading "Partial" while a component is fully down needs that
    // said rather than inferred.
    expect(explainHeadline(PAGE_STATUS_MESSAGES.PARTIAL_OUTAGE, counts({ up: 11, down: 1 }))).toContain(
      "never changes whether a component is down",
    );
  });

  it("uses the degraded arithmetic when nothing is down", () => {
    expect(explainHeadline(PAGE_STATUS_MESSAGES.PARTIAL_DEGRADED, counts({ up: 3, degraded: 1 }))).toContain(
      "1 of 4 components is degraded, which is 25%",
    );
  });

  it("uses the singular for one component", () => {
    expect(explainHeadline(PAGE_STATUS_MESSAGES.ALL_OPERATIONAL, counts({ up: 1 }))).toBe(
      "All 1 counted component is operational.",
    );
  });
});

describe("explainComponent", () => {
  const edge = (parent: string, child: string): DependencyEdge => ({
    parent_monitor_tag: parent,
    child_monitor_tag: child,
    relation: "DEPENDS_ON",
    propagation: "WORST",
    weight: 1,
  });

  const inputs = (over: Partial<ExplainInputs> = {}): ExplainInputs => ({
    nameByTag: new Map([
      ["api", "The API"],
      ["db", "Postgres"],
    ]),
    latest: [{ monitor_tag: "api", status: "UP", raw_status: "UP" }],
    incidentImpacts: [],
    maintenanceImpacts: [],
    edges: [],
    settings: [],
    resolved: new Map<string, ComponentImpact>(),
    displayable: new Set(["api", "db"]),
    nowSeconds: 1000,
    ...over,
  });

  const component = (over: Partial<ComponentStatus> = {}): ComponentStatus => ({
    monitor_tag: "api",
    component_impact: "OPERATIONAL",
    source: "monitoring",
    monitor_impact: null,
    ...over,
  });

  it("says so plainly when nothing is declared and the check is up", () => {
    const explained = explainComponent(component(), inputs());
    expect(explained.reason).toBe("Its own check last reported UP, and nothing is declared against it.");
    expect(explained.counted).toBe(true);
  });

  it("names the incident that declared the impact", () => {
    const explained = explainComponent(
      component({ component_impact: "MAJOR_OUTAGE", source: "incident" }),
      inputs({
        incidentImpacts: [
          {
            id: 7,
            title: "Datacentre power",
            monitor_tag: "api",
            monitor_impact: "DOWN",
            component_impact: "MAJOR_OUTAGE",
            impact_override: null,
          },
        ],
      }),
    );
    expect(explained.reason).toBe("An open incident declares major outage on this component: Datacentre power.");
    expect(explained.incidents).toEqual([{ id: 7, title: "Datacentre power", impact: "MAJOR_OUTAGE" }]);
  });

  it("says an override outranks the monitor's own check, because that is the surprising part", () => {
    const explained = explainComponent(
      component({ component_impact: "MAJOR_OUTAGE", source: "override" }),
      inputs({
        incidentImpacts: [
          {
            id: 9,
            title: "Declared outage",
            monitor_tag: "api",
            monitor_impact: null,
            component_impact: null,
            impact_override: "MAJOR_OUTAGE",
          },
        ],
      }),
    );
    expect(explained.reason).toContain("overrides this component to major outage");
    expect(explained.reason).toContain("outranks everything else");
  });

  it("names the maintenance", () => {
    const explained = explainComponent(
      component({ component_impact: "UNDER_MAINTENANCE", source: "maintenance" }),
      inputs({
        maintenanceImpacts: [
          {
            id: 3,
            title: "Index rebuild",
            monitor_tag: "api",
            monitor_impact: "MAINTENANCE",
            component_impact: "UNDER_MAINTENANCE",
          },
        ],
      }),
    );
    expect(explained.reason).toContain("Index rebuild");
    expect(explained.maintenances).toEqual([{ id: 3, title: "Index rebuild", impact: "UNDER_MAINTENANCE" }]);
  });

  /** The case that started this: the headline disagreed with the own check. */
  it("names the dependency and what the component's own check said", () => {
    const explained = explainComponent(
      component({ component_impact: "MAJOR_OUTAGE", source: "rollup" }),
      inputs({
        edges: [edge("api", "db")],
        resolved: new Map<string, ComponentImpact>([
          ["api", "MAJOR_OUTAGE"],
          ["db", "MAJOR_OUTAGE"],
        ]),
      }),
    );
    expect(explained.reason).toBe("Inherited from Postgres. Its own check last reported UP.");
    expect(explained.inherited_from).toEqual(["Postgres"]);
  });

  it("still explains a rollup whose dependency may not be named", () => {
    // C3b's rule: a hidden or inactive dependency moves the status it always
    // moved and is still not named, so the sentence has to stand without it.
    const explained = explainComponent(
      component({ component_impact: "MAJOR_OUTAGE", source: "rollup" }),
      inputs({
        edges: [edge("api", "db")],
        displayable: new Set(["api"]),
        resolved: new Map<string, ComponentImpact>([
          ["api", "MAJOR_OUTAGE"],
          ["db", "MAJOR_OUTAGE"],
        ]),
      }),
    );
    expect(explained.inherited_from).toEqual([]);
    expect(explained.reason).toContain("hidden or inactive, so it is not named");
  });

  it("reports a live pin as a typed value rather than as something the monitoring found", () => {
    const explained = explainComponent(
      component({ component_impact: "UNDER_MAINTENANCE", source: "rollup" }),
      inputs({
        settings: [
          {
            monitor_tag: "api",
            rollup_mode: "WORST",
            manual_override: "UNDER_MAINTENANCE",
            manual_override_expires_at: null,
          },
        ],
      }),
    );
    expect(explained.reason).toContain("pinned this component at under maintenance");
    expect(explained.reason).toContain("not something the monitoring found");
    expect(explained.pin).toEqual({ impact: "UNDER_MAINTENANCE", expires_at: null });
  });

  it("ignores a pin that has lapsed, exactly as the derivation does", () => {
    const explained = explainComponent(
      component({ component_impact: "MAJOR_OUTAGE", source: "rollup" }),
      inputs({
        edges: [edge("api", "db")],
        resolved: new Map<string, ComponentImpact>([
          ["api", "MAJOR_OUTAGE"],
          ["db", "MAJOR_OUTAGE"],
        ]),
        settings: [
          {
            monitor_tag: "api",
            rollup_mode: "WORST",
            manual_override: "UNDER_MAINTENANCE",
            manual_override_expires_at: 999,
          },
        ],
        nowSeconds: 1000,
      }),
    );
    expect(explained.pin).toBeNull();
    expect(explained.reason).toContain("Inherited from Postgres");
  });

  it("says a silent component is left out of the arithmetic rather than counted as healthy", () => {
    const explained = explainComponent(
      component({ source: "silent" }),
      inputs({ latest: [{ monitor_tag: "api", status: null }] }),
    );
    expect(explained.counted).toBe(false);
    expect(explained.reason).toContain("never reported");
    expect(explained.reason).toContain("rather than counted as healthy");
  });

  /** C3c writes the verdict into `status`; `raw_status` is what the check saw. */
  it("prefers the check's own observation over the published verdict", () => {
    const explained = explainComponent(
      component({ component_impact: "MAJOR_OUTAGE", source: "rollup" }),
      inputs({
        latest: [{ monitor_tag: "api", status: "DOWN", raw_status: "UP" }],
        edges: [edge("api", "db")],
        resolved: new Map<string, ComponentImpact>([
          ["api", "MAJOR_OUTAGE"],
          ["db", "MAJOR_OUTAGE"],
        ]),
      }),
    );
    expect(explained.own_status).toBe("DOWN");
    expect(explained.own_check).toBe("UP");
    expect(explained.reason).toContain("own check last reported UP");
  });
});
