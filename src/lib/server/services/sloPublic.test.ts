import { describe, it, expect } from "vitest";
import { publicSloView, publishedSlosFor, publicSloSurfacesFor, type PublishedTarget } from "./sloPublic.js";
import type { SlaEvaluationRow, SlaTargetRow } from "../db/repositories/sla.js";

function target(overrides: Partial<SlaTargetRow> = {}): SlaTargetRow {
  return {
    id: 1,
    org_id: 1,
    name: "API availability",
    scope_type: "MONITOR",
    scope_ref: "api",
    combination: "WORST",
    region_id: 0,
    objective_percent: 99.9,
    window_type: "ROLLING",
    window_days: 30,
    calendar_period: null,
    exclude_maintenance: "YES",
    degraded_counts_as_bad: "NO",
    show_on_public: "YES",
    public_placements: ["COMPONENT_PAGE"],
    public_detail: "FULL",
    status: "ACTIVE",
    ...overrides,
  };
}

function evaluation(overrides: Partial<SlaEvaluationRow> = {}): SlaEvaluationRow {
  return {
    sla_target_id: 1,
    window_start: 1_756_684_800,
    window_end: 1_759_276_800,
    count_total: 1000,
    count_good: 1000,
    count_bad: 0,
    count_excluded: 0,
    uptime_percent: 99.99,
    objective_percent: 99.9,
    budget_total: 1,
    budget_consumed: 0,
    budget_remaining_percent: 90,
    burn_1h: 0.5,
    burn_6h: 0.2,
    burn_24h: 0.1,
    burn_3d: 0,
    monitor_count: 1,
    computed_at: 1_759_276_800,
    ...overrides,
  };
}

const row = (t: Partial<SlaTargetRow> = {}, e: Partial<SlaEvaluationRow> | null = {}): PublishedTarget => ({
  target: target(t),
  evaluation: e === null ? null : evaluation(e),
});

describe("publicSloView", () => {
  it("never publishes burn rates or the target's configuration", () => {
    const view = publicSloView(target(), evaluation());
    expect(view).not.toBeNull();
    // Every value a loader returns is serialised into the page whether or not a
    // template renders it, so this is the assertion that keeps an operational
    // signal off a public page.
    expect(Object.keys(view!).sort()).toEqual([
      "breached",
      "budgetRemainingPercent",
      "name",
      "objectivePercent",
      "uptimePercent",
      "window",
    ]);
  });

  it("drops the extra fields under the COMPACT preset", () => {
    const view = publicSloView(target({ public_detail: "COMPACT" }), evaluation());
    expect(view?.uptimePercent).toBe(99.99);
    expect(view?.budgetRemainingPercent).toBeNull();
    expect(view?.window).toBeNull();
  });

  it("returns nothing when there is no honest figure to show", () => {
    // A target created minutes ago, and one whose window holds no samples.
    expect(publicSloView(target(), null)).toBeNull();
    expect(publicSloView(target(), evaluation({ uptime_percent: null }))).toBeNull();
  });

  it("marks a breach when attainment falls below the objective", () => {
    expect(publicSloView(target(), evaluation({ uptime_percent: 99.5 }))?.breached).toBe(true);
    // Exactly at the objective is met, not breached.
    expect(publicSloView(target(), evaluation({ uptime_percent: 99.9 }))?.breached).toBe(false);
  });

  it("labels a calendar window from the evaluation, not the clock", () => {
    const view = publicSloView(
      target({ window_type: "CALENDAR", calendar_period: "MONTH", window_days: null }),
      // 2026-09-01T00:00:00Z
      evaluation({ window_start: 1_788_220_800 }),
    );
    expect(view?.window).toBe("2026-09 (UTC)");
  });
});

describe("publishedSlosFor", () => {
  it("returns only targets placed on the surface asked for", () => {
    const rows = [
      row({ id: 1, name: "on the component page", public_placements: ["COMPONENT_PAGE"] }),
      row({ id: 2, name: "on the status page", public_placements: ["STATUS_PAGE_COMPONENT"] }),
      row({ id: 3, name: "nowhere", public_placements: [] }),
    ];
    expect(publishedSlosFor(rows, "COMPONENT_PAGE").map((slo) => slo.name)).toEqual(["on the component page"]);
  });

  it("narrows to one scope ref when given one", () => {
    const rows = [row({ id: 1, scope_ref: "api", name: "api" }), row({ id: 2, scope_ref: "web", name: "web" })];
    expect(publishedSlosFor(rows, "COMPONENT_PAGE", "web").map((slo) => slo.name)).toEqual(["web"]);
  });
});

describe("publicSloSurfacesFor", () => {
  const allowed = {
    pageRef: "1",
    monitors: new Set(["api", "web"]),
    categories: new Set(["Platform"]),
  };

  it("buckets each scope onto its own surface", () => {
    const surfaces = publicSloSurfacesFor(
      [
        row({ id: 1, scope_type: "PAGE", scope_ref: "1", name: "page", public_placements: ["PAGE_TOP"] }),
        row({
          id: 2,
          scope_type: "CATEGORY",
          scope_ref: "Platform",
          name: "category",
          public_placements: ["CATEGORY_SECTION"],
        }),
        row({ id: 3, scope_ref: "api", name: "component", public_placements: ["STATUS_PAGE_COMPONENT"] }),
      ],
      allowed,
    );

    // This is the bug the whole change exists for: before placements, page- and
    // category-scoped targets had no bucket at all and rendered nowhere.
    expect(surfaces.pageSlos.map((s) => s.name)).toEqual(["page"]);
    expect(surfaces.categorySlos["Platform"].map((s) => s.name)).toEqual(["category"]);
    expect(surfaces.monitorSlos["api"].map((s) => s.name)).toEqual(["component"]);
  });

  it("leaves out a target placed only on its component page while it is met", () => {
    const surfaces = publicSloSurfacesFor([row({ scope_ref: "api", public_placements: ["COMPONENT_PAGE"] })], allowed);
    expect(surfaces.monitorSlos).toEqual({});
  });

  it("surfaces a breach even when it was placed somewhere else entirely", () => {
    // The one case where a figure appears on a surface it was not placed on.
    const surfaces = publicSloSurfacesFor(
      [row({ scope_ref: "api", public_placements: ["COMPONENT_PAGE"] }, { uptime_percent: 99.0 })],
      allowed,
    );
    expect(surfaces.monitorSlos["api"]?.[0].breached).toBe(true);
  });

  it("renders a target that is both placed here and breached exactly once", () => {
    const surfaces = publicSloSurfacesFor(
      [row({ scope_ref: "api", public_placements: ["STATUS_PAGE_COMPONENT"] }, { uptime_percent: 99.0 })],
      allowed,
    );
    expect(surfaces.monitorSlos["api"]).toHaveLength(1);
  });

  it("never carries a ref this page does not show", () => {
    // Otherwise a status page would publish every other page's components in its
    // hydration payload, which is readable whether or not anything renders it.
    const surfaces = publicSloSurfacesFor(
      [
        row({ id: 1, scope_ref: "elsewhere", public_placements: ["STATUS_PAGE_COMPONENT"] }),
        row({ id: 2, scope_type: "PAGE", scope_ref: "99", public_placements: ["PAGE_TOP"] }),
        row({ id: 3, scope_type: "CATEGORY", scope_ref: "Other", public_placements: ["CATEGORY_SECTION"] }),
      ],
      allowed,
    );
    expect(surfaces.monitorSlos).toEqual({});
    expect(surfaces.pageSlos).toEqual([]);
    expect(surfaces.categorySlos).toEqual({});
  });

  it("ignores a target with no evaluation yet", () => {
    const surfaces = publicSloSurfacesFor(
      [row({ scope_ref: "api", public_placements: ["STATUS_PAGE_COMPONENT"] }, null)],
      allowed,
    );
    expect(surfaces.monitorSlos).toEqual({});
  });
});

describe("a category figure on a page that does not group by category", () => {
  const base = {
    pageRef: "1",
    monitors: new Set(["api", "web"]),
    categories: new Set(["Platform"]),
  };

  const categoryTarget = row({
    id: 9,
    scope_type: "CATEGORY",
    scope_ref: "Platform",
    name: "Platform availability",
    public_placements: ["CATEGORY_SECTION"],
  });

  it("goes on the section header when the page draws them", () => {
    const surfaces = publicSloSurfacesFor([categoryTarget], { ...base, hasCategorySections: true });
    expect(surfaces.categorySlos.Platform?.map((s) => s.name)).toEqual(["Platform availability"]);
    expect(surfaces.pageSlos).toEqual([]);
  });

  it("falls back to the page-top panel when the page draws none", () => {
    // Without this it was serialised into the hydration payload and rendered by
    // nothing: the figure was in the HTML and invisible on the page.
    const surfaces = publicSloSurfacesFor([categoryTarget], { ...base, hasCategorySections: false });
    expect(surfaces.pageSlos.map((s) => s.name)).toEqual(["Platform availability"]);
    expect(surfaces.categorySlos).toEqual({});
  });

  it("appears exactly once, never on both surfaces", () => {
    for (const hasCategorySections of [true, false]) {
      const surfaces = publicSloSurfacesFor([categoryTarget], { ...base, hasCategorySections });
      const total = surfaces.pageSlos.length + Object.values(surfaces.categorySlos).flat().length;
      expect(total).toBe(1);
    }
  });

  it("defaults to drawing section headers when nothing says otherwise", () => {
    // The component page and anything else with no grouping setting must keep
    // behaving as it did, rather than silently moving every category figure.
    const surfaces = publicSloSurfacesFor([categoryTarget], base);
    expect(surfaces.categorySlos.Platform).toHaveLength(1);
    expect(surfaces.pageSlos).toEqual([]);
  });

  it("still drops a category this page does not show", () => {
    const surfaces = publicSloSurfacesFor(
      [row({ scope_type: "CATEGORY", scope_ref: "Somebody Else", public_placements: ["CATEGORY_SECTION"] })],
      { ...base, hasCategorySections: false },
    );
    expect(surfaces.pageSlos).toEqual([]);
    expect(surfaces.categorySlos).toEqual({});
  });

  it("does not merge a page-scoped and a category-scoped figure into one entry", () => {
    const surfaces = publicSloSurfacesFor(
      [
        row({ id: 1, scope_type: "PAGE", scope_ref: "1", name: "Page uptime", public_placements: ["PAGE_TOP"] }),
        categoryTarget,
      ],
      { ...base, hasCategorySections: false },
    );
    expect(surfaces.pageSlos.map((s) => s.name).sort()).toEqual(["Page uptime", "Platform availability"]);
  });
});
